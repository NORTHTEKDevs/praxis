import { SkillStore } from './store.ts'
import type { Embedder } from './embedder.ts'
import { HashingEmbedder } from './embedder.ts'
import { captureSkill } from './capture.ts'
import type { CaptureInput } from './capture.ts'
import { verifySkill } from './verify.ts'
import type { VerifyResult } from './verify.ts'
import { maybeMerge, findStatusDuplicate } from './dedup.ts'
import { recall } from './retrieve.ts'
import type { RecallResult, RecallOptions } from './retrieve.ts'
import { runSkill } from './run.ts'
import type { RunResult } from './run.ts'
import { reinforce, retier } from './utility.ts'
import { recordFailure } from './negative.ts'
import type { FailureInput } from './negative.ts'
import { resolveComposition, parseCalls, quarantineCascade } from './composition.ts'
import type { Skill, SkillStatus } from './skill.ts'
import { RateLimiter, Semaphore, RateLimitError } from './concurrency.ts'

export { RateLimiter, Semaphore, RateLimitError }

export interface RememberResult {
  id: string
  status: SkillStatus
  reason?: string
}

export interface PraxisOptions {
  rememberPerMin?: number
  maxConcurrentVerify?: number
  maxDepth?: number
  hotCap?: number
}

// The orchestration surface the MCP server and CLI call into.
export class Praxis {
  store: SkillStore
  embedder: Embedder
  limiter: RateLimiter
  sem: Semaphore
  maxDepth: number
  hotCap: number
  writeChain: Promise<unknown>

  constructor(store?: SkillStore, embedder?: Embedder, opts: PraxisOptions = {}) {
    this.store = store ?? new SkillStore(':memory:')
    this.embedder = embedder ?? new HashingEmbedder()
    this.limiter = new RateLimiter(opts.rememberPerMin ?? 60, 60_000)
    this.sem = new Semaphore(opts.maxConcurrentVerify ?? 4)
    this.maxDepth = opts.maxDepth ?? 5
    this.hotCap = opts.hotCap ?? 200
    this.writeChain = Promise.resolve()
  }

  // serialize a critical section (the dedup read-check-insert) across concurrent calls.
  private withLock(fn: () => Promise<unknown>): Promise<unknown> {
    const run = this.writeChain.then(() => fn())
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // store a non-verified candidate, deduped against same-status near-duplicates (so repeated
  // remember() of an identical broken skill does not accumulate rows), under the write-lock.
  private async insertNonVerified(candidate: Skill, status: SkillStatus, reason?: string): Promise<RememberResult> {
    candidate.status = status
    return (await this.withLock(async () => {
      candidate.embedding = await this.embedder.embed(this.text(candidate))
      const dup = await findStatusDuplicate(this.store, candidate, this.embedder)
      if (dup) return { id: dup, status, reason: 'duplicate' }
      const id = this.store.insert(candidate)
      return { id, status, reason }
    })) as RememberResult
  }

  private text(s: Skill): string {
    return `${s.name} ${s.interface} ${s.provenance.task}`
  }

  // capture -> resolve composition -> verify (fail-closed) -> dedup -> store -> deps -> retier
  async remember(input: CaptureInput): Promise<RememberResult> {
    if (!this.limiter.allow()) throw new RateLimitError('remember rate limit exceeded')
    const candidate = captureSkill(input)
    candidate.kind = 'positive' // recordFailure is the only path that creates negatives

    let deps: string[] = []
    let subImpls: Record<string, string> = {}
    if (parseCalls(candidate.implementation).length > 0) {
      const comp = resolveComposition(this.store, candidate.implementation, candidate.capabilities, this.maxDepth)
      if (!comp.ok) {
        return this.insertNonVerified(candidate, 'quarantined', comp.reason)
      }
      subImpls = comp.subImpls
      deps = comp.deps
    }

    const v = (await this.sem.run(() =>
      verifySkill(
        { implementation: candidate.implementation, acceptanceTest: candidate.acceptanceTest },
        { subImpls, maxDepth: this.maxDepth },
      ),
    )) as VerifyResult
    candidate.status = v.status

    if (v.status === 'verified') {
      // serialize the dedup read-check-insert: the embed() inside maybeMerge yields the event
      // loop, so two concurrent remember() calls of identical content could otherwise both
      // insert. The lock makes the second one see + reinforce the first.
      return (await this.withLock(async () => {
        const d = await maybeMerge(this.store, candidate, this.embedder)
        // deps were parsed from the CANDIDATE's impl; register them only when the candidate is
        // what we stored (inserted). On reinforced/duplicate, d.id is a DIFFERENT existing skill
        // that keeps its own deps - writing the candidate's deps onto it would be wrong.
        if (d.action === 'inserted' && deps.length) {
          for (const dep of deps) this.store.addDep(d.id, dep)
          // TOCTOU guard: verify ran BEFORE this lock. A concurrent reinforce(dep,'failure')
          // could have demoted a sub-skill while this composite was mid-verify, and its cascade
          // would have missed the not-yet-inserted composite. Now that the dep edges exist,
          // re-check each dep's CURRENT status synchronously (no await -> no interleave). If any
          // is no longer verified, quarantine this composite so it never sits verified atop an
          // invalidated sub-skill. (Any reinforce that demotes a dep AFTER this check sees the
          // edge and cascades the composite itself.)
          const stale = deps.find((dep) => this.store.get(dep)?.status !== 'verified')
          if (stale) {
            this.store.updateStatus(d.id, 'quarantined')
            return { id: d.id, status: 'quarantined', reason: 'sub-skill invalidated before commit' }
          }
        }
        retier(this.store, this.hotCap)
        return { id: d.id, status: 'verified', reason: d.action === 'inserted' ? undefined : d.action }
      })) as RememberResult
    }

    return this.insertNonVerified(candidate, v.status, v.reason)
  }

  recall(query: string, opts?: RecallOptions): Promise<RecallResult> {
    return recall(this.store, this.embedder, query, opts)
  }

  run(id: string, input: unknown): Promise<RunResult> {
    // share the verify semaphore: run() spawns a sandbox Worker too, so an unbounded flood of
    // run_skill calls would otherwise spawn unbounded worker threads / memory -- the same DoS the
    // remember() and reinforce() paths are already bounded against.
    return this.sem.run(() => runSkill(this.store, id, input, { maxDepth: this.maxDepth })) as Promise<RunResult>
  }

  async recordFailure(input: FailureInput): Promise<string> {
    if (!this.limiter.allow()) throw new RateLimitError('record_failure rate limit exceeded')
    return recordFailure(this.store, this.embedder, input)
  }

  async reinforce(id: string, outcome: 'success' | 'failure'): Promise<Skill | undefined> {
    if (outcome !== 'success' && outcome !== 'failure') throw new Error('reinforce: outcome must be "success" or "failure"')
    const existing = this.store.get(id)
    if (!existing) throw new Error(`reinforce: no skill with id ${id}`)
    if (existing.kind === 'negative') throw new Error('reinforce: cannot reinforce a negative record')
    if (existing.status !== 'verified') throw new Error(`reinforce: skill is not verified (status: ${existing.status})`)
    // Rate-limit BOTH outcomes (shared limiter): 'failure' re-runs the sandbox, and EVERY
    // reinforce drives an O(N) retier -- so an unthrottled reinforce('success') flood is itself
    // a load-amplification DoS, not just the 'failure' path.
    if (!this.limiter.allow()) throw new RateLimitError('reinforce rate limit exceeded')
    // resolve the composition so the anti-regression re-run sees its sub-skill impls; a COMPOSED
    // skill would otherwise throw 'unknown sub-skill' and be false-quarantined on every failure
    // report. If a dep is no longer verified, comp.ok is false -> pass {} -> the re-run fails ->
    // quarantine, which is the CORRECT outcome for a now-broken composition.
    let subImpls: Record<string, string> = {}
    if (outcome === 'failure' && parseCalls(existing.implementation).length > 0) {
      const comp = resolveComposition(this.store, existing.implementation, existing.capabilities, this.maxDepth)
      if (comp.ok) subImpls = comp.subImpls
    }
    // bound worker spawning: reinforce('failure') runs verifySkill (up to 2 workers). Share the
    // verify semaphore with remember() so concurrent reinforce calls cannot spawn unbounded
    // worker threads (DoS).
    const r = (await this.sem.run(() => reinforce(this.store, id, outcome, subImpls))) as Skill | undefined
    if (r && r.status !== 'verified') quarantineCascade(this.store, id)
    retier(this.store, this.hotCap)
    return r
  }

  pin(id: string, pinned = true): void {
    const s = this.store.get(id)
    if (!s) throw new Error(`pin: no skill with id ${id}`)
    if (pinned && (s.status !== 'verified' || s.kind !== 'positive')) {
      throw new Error('pin: only verified positive skills may be pinned')
    }
    s.pinned = pinned
    this.store.update(s)
  }

  stats() {
    const all = this.store.all()
    const verified = all.filter((s) => s.status === 'verified' && s.kind === 'positive')
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
    return {
      total: all.length,
      verified: verified.length,
      quarantined: all.filter((s) => s.status === 'quarantined').length,
      negatives: all.filter((s) => s.kind === 'negative').length,
      hot: verified.filter((s) => s.tier === 'hot').length,
      warm: verified.filter((s) => s.tier === 'warm').length,
      cold: verified.filter((s) => s.tier === 'cold').length,
      pinned: all.filter((s) => s.pinned).length,
      avgCheckStrength: mean(verified.map((s) => s.checkStrength)),
      weakTests: verified.filter((s) => s.checkStrength < 2).length,
      topSkills: [...verified]
        .sort((a, b) => b.utilityScore - a.utilityScore)
        .slice(0, 5)
        .map((s) => ({ name: s.name, utilityScore: s.utilityScore })),
    }
  }
}
