import { SkillStore } from './store.ts'
import type { Embedder } from './embedder.ts'
import { cosine } from './embedder.ts'
import { verifySkill } from './verify.ts'
import type { VerifyResult } from './verify.ts'
import { EMBEDDER_VERSION } from './skill.ts'
import type { Skill } from './skill.ts'
import { Semaphore } from './concurrency.ts'
import { retier, DEFAULT_HOT_CAP } from './utility.ts'
import { resolveComposition, quarantineCascade } from './composition.ts'

export interface ConsolidateResult {
  merged: number
  flagged: number
  evicted: number
  durationMs: number
}

export interface ConsolidateOpts {
  dryRun?: boolean
  minInstances?: number
  cosineThreshold?: number
  evictThreshold?: number
  lengthRatioMax?: number
  concurrency?: number
  hotCap?: number
}

// Per-store in-process mutex: two passes on the SAME store must not interleave writes;
// independent stores may consolidate concurrently.
const _locks = new WeakMap<SkillStore, { busy: boolean }>()

function interfaceCompatible(a: Skill, b: Skill): boolean {
  return a.interface.trim() === b.interface.trim()
}

function lenRatio(a: string, b: string): number {
  const x = a.length || 1
  const y = b.length || 1
  return Math.max(x, y) / Math.min(x, y)
}

// Periodic compaction. v1 merge is DETERMINISTIC (fold true near-duplicates), gated by a
// regression check: the keeper must pass every folded skill's acceptance test before they
// are archived. Clusters smaller than minInstances are FLAGGED for human review, never
// auto-merged. (LLM-proposed generalization of related-but-distinct skills is a v2 feature.)
export async function consolidate(
  store: SkillStore,
  embedder: Embedder,
  opts: ConsolidateOpts = {},
): Promise<ConsolidateResult> {
  let lock = _locks.get(store)
  if (!lock) {
    lock = { busy: false }
    _locks.set(store, lock)
  }
  if (lock.busy) throw new Error('consolidation already in progress')
  lock.busy = true
  const start = Date.now()
  try {
    const minInstances = opts.minInstances ?? 3
    const cosT = opts.cosineThreshold ?? 0.92
    const evictT = opts.evictThreshold ?? 0.1
    const lenMax = opts.lengthRatioMax ?? 3
    const dryRun = opts.dryRun ?? false
    const sem = new Semaphore(opts.concurrency ?? 4)
    let merged = 0
    let flagged = 0
    let evicted = 0

    const verified = store.listByStatus('verified').filter((s) => s.kind === 'positive' && s.embedding.length > 0)
    const used = new Set<string>()
    const toArchive: string[] = []

    for (const a of verified) {
      if (used.has(a.id)) continue
      const cluster = [a]
      for (const b of verified) {
        if (b.id === a.id || used.has(b.id)) continue
        if (b.embedderVersion !== a.embedderVersion) continue
        if (!interfaceCompatible(a, b)) continue
        if (lenRatio(a.implementation, b.implementation) >= lenMax) continue
        if (cosine(a.embedding, b.embedding) >= cosT) cluster.push(b)
      }
      if (cluster.length < 2) continue
      for (const c of cluster) used.add(c.id)
      if (cluster.length < minInstances) {
        flagged++
        continue
      }
      cluster.sort((x, y) => y.checkStrength - x.checkStrength || y.utilityScore - x.utilityScore)
      const keeper = cluster[0]
      const others = cluster.slice(1)
      // a composed keeper must verify WITH its sub-skills resolved (otherwise call() throws
      // and the merge-safety check is a false negative). Skip clusters we cannot resolve.
      const keeperComp = resolveComposition(store, keeper.implementation, keeper.capabilities)
      if (!keeperComp.ok) {
        flagged++
        continue
      }
      let safe = true
      for (const o of others) {
        if (!o.acceptanceTest.trim()) continue
        const v = (await sem.run(() =>
          verifySkill(
            { implementation: keeper.implementation, acceptanceTest: o.acceptanceTest },
            { subImpls: keeperComp.subImpls },
          ),
        )) as VerifyResult
        if (v.status !== 'verified') {
          safe = false
          break
        }
      }
      if (!safe) {
        flagged++
        continue
      }
      if (!dryRun) for (const o of others) toArchive.push(o.id)
      merged += others.length
    }

    // apply archival AFTER all clusters resolve, so an earlier merge does not hide a
    // sub-skill a later cluster's keeper composition depends on. Then cascade-quarantine any
    // composed skill that depended (by id) on a now-archived skill.
    if (!dryRun) {
      for (const id of toArchive) store.updateStatus(id, 'archived')
      for (const id of toArchive) quarantineCascade(store, id)
    }

    for (const s of store.listByTier('cold')) {
      if (s.status !== 'verified' || s.pinned) continue
      if (s.utilityScore < evictT) {
        if (!dryRun) store.updateStatus(s.id, 'archived')
        evicted++
      }
    }

    // refresh tiers on the surviving verified set so recall sees current utility.
    if (!dryRun) retier(store, opts.hotCap ?? DEFAULT_HOT_CAP)
    return { merged, flagged, evicted, durationMs: Date.now() - start }
  } finally {
    lock.busy = false
  }
}

// Re-embed every skill with the current embedder and stamp the version (the migration path
// when the embedder changes -- otherwise cross-version cosine is refused).
export async function reindex(store: SkillStore, embedder: Embedder): Promise<number> {
  let n = 0
  for (const s of store.all()) {
    const text = s.kind === 'negative' ? s.provenance.task : `${s.name} ${s.interface} ${s.provenance.task}`
    s.embedding = await embedder.embed(text)
    s.embedderVersion = EMBEDDER_VERSION
    store.update(s)
    n++
  }
  return n
}
