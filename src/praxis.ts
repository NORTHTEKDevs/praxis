import { SkillStore } from './store.ts'
import type { Embedder } from './embedder.ts'
import { HashingEmbedder } from './embedder.ts'
import { captureSkill } from './capture.ts'
import type { CaptureInput } from './capture.ts'
import { verifySkill } from './verify.ts'
import type { VerifyResult } from './verify.ts'
import { maybeMerge } from './dedup.ts'
import { recall } from './retrieve.ts'
import type { RecallResult } from './retrieve.ts'
import { runSkill } from './run.ts'
import type { RunResult } from './run.ts'
import { reinforce, retier } from './utility.ts'
import { recordFailure } from './negative.ts'
import type { FailureInput } from './negative.ts'
import { resolveComposition, parseCalls, quarantineCascade } from './composition.ts'
import type { Skill, SkillStatus } from './skill.ts'

export class RateLimitError extends Error {}

// Sliding-window rate limiter.
export class RateLimiter {
  max: number
  windowMs: number
  hits: number[]
  constructor(max: number, windowMs: number) {
    this.max = max
    this.windowMs = windowMs
    this.hits = []
  }
  allow(now = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs)
    if (this.hits.length >= this.max) return false
    this.hits.push(now)
    return true
  }
}

// Bounds the number of concurrent sandbox workers (a flooding agent must not spawn
// unbounded workers and OOM the host).
export class Semaphore {
  max: number
  active: number
  queue: Array<() => void>
  constructor(max: number) {
    this.max = max
    this.active = 0
    this.queue = []
  }
  async run(fn: () => Promise<unknown>): Promise<unknown> {
    if (this.active >= this.max) await new Promise<void>((res) => this.queue.push(res))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      const next = this.queue.shift()
      if (next) next()
    }
  }
}

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

  constructor(store?: SkillStore, embedder?: Embedder, opts: PraxisOptions = {}) {
    this.store = store ?? new SkillStore(':memory:')
    this.embedder = embedder ?? new HashingEmbedder()
    this.limiter = new RateLimiter(opts.rememberPerMin ?? 60, 60_000)
    this.sem = new Semaphore(opts.maxConcurrentVerify ?? 4)
    this.maxDepth = opts.maxDepth ?? 5
    this.hotCap = opts.hotCap ?? 200
  }

  private text(s: Skill): string {
    return `${s.name} ${s.interface} ${s.provenance.task}`
  }

  // capture -> resolve composition -> verify (fail-closed) -> dedup -> store -> deps -> retier
  async remember(input: CaptureInput): Promise<RememberResult> {
    if (!this.limiter.allow()) throw new RateLimitError('remember rate limit exceeded')
    const candidate = captureSkill(input)

    let deps: string[] = []
    let subImpls: Record<string, string> = {}
    if (parseCalls(candidate.implementation).length > 0) {
      const comp = resolveComposition(this.store, candidate.implementation, candidate.capabilities, this.maxDepth)
      if (!comp.ok) {
        candidate.status = 'quarantined'
        candidate.embedding = await this.embedder.embed(this.text(candidate))
        const id = this.store.insert(candidate)
        return { id, status: 'quarantined', reason: comp.reason }
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
      const d = await maybeMerge(this.store, candidate, this.embedder)
      if (d.action === 'inserted') {
        for (const dep of deps) this.store.addDep(d.id, dep)
        retier(this.store, this.hotCap)
        return { id: d.id, status: 'verified' }
      }
      return { id: d.id, status: 'verified', reason: d.action }
    }

    candidate.embedding = await this.embedder.embed(this.text(candidate))
    const id = this.store.insert(candidate)
    return { id, status: v.status, reason: v.reason }
  }

  recall(query: string, opts?: { k?: number; tokenBudget?: number }): Promise<RecallResult> {
    return recall(this.store, this.embedder, query, opts)
  }

  run(id: string, input: unknown): Promise<RunResult> {
    return runSkill(this.store, id, input, { maxDepth: this.maxDepth })
  }

  recordFailure(input: FailureInput): Promise<string> {
    return recordFailure(this.store, this.embedder, input)
  }

  async reinforce(id: string, outcome: 'success' | 'failure'): Promise<Skill | undefined> {
    const r = await reinforce(this.store, id, outcome)
    if (r && r.status !== 'verified') quarantineCascade(this.store, id)
    return r
  }

  pin(id: string, pinned = true): void {
    const s = this.store.get(id)
    if (!s) return
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
