import { SkillStore } from './store.ts'
import { verifySkill } from './verify.ts'
import type { Skill } from './skill.ts'

// Explicit weights (the formula must be reproducible, not hand-wavy).
export const WEIGHTS = { uses: 0.3, successRate: 0.35, recency: 0.2, generality: 0.15 }
export const HALF_LIFE_DAYS = 30
export const DEFAULT_HOT_CAP = 200

export function recencyDecay(createdAt: number, halfLifeDays = HALF_LIFE_DAYS, now = Date.now()): number {
  if (!createdAt || createdAt <= 0) return 1
  const days = (now - createdAt) / 86_400_000
  if (days <= 0) return 1
  return Math.exp((-Math.LN2 * days) / halfLifeDays)
}

// generality = number of DISTINCT task queries that retrieved this skill (breadth of use).
export function utilityScore(skill: Skill, generality: number, now = Date.now()): number {
  return (
    WEIGHTS.uses * Math.log(1 + skill.uses) +
    WEIGHTS.successRate * skill.successRate +
    WEIGHTS.recency * recencyDecay(skill.provenance.createdAt, HALF_LIFE_DAYS, now) +
    WEIGHTS.generality * generality
  )
}

// Record a usage outcome and recompute the score. A reported FAILURE triggers an
// anti-regression check: re-run the acceptance test; if it no longer passes, the skill is
// quarantined (it can no longer be trusted) rather than left in the verified set.
export async function reinforce(
  store: SkillStore,
  id: string,
  outcome: 'success' | 'failure',
  subImpls: Record<string, string> = {},
): Promise<Skill | undefined> {
  let skill = store.get(id)
  if (!skill) return undefined

  // Run the async anti-regression check FIRST, then RE-READ the row. verifySkill yields the
  // event loop; a concurrent quarantine during that window must not be overwritten by a stale
  // snapshot (TOCTOU).
  if (outcome === 'failure' && skill.acceptanceTest.trim()) {
    // pass resolved sub-skill impls so a COMPOSED skill's call('dep') resolves -- otherwise the
    // re-run throws 'unknown sub-skill' (runtime) and false-quarantines a correct composed skill.
    const v = await verifySkill({ implementation: skill.implementation, acceptanceTest: skill.acceptanceTest }, { subImpls })
    skill = store.get(id)
    if (!skill) return undefined
    if (v.status !== 'verified') {
      if (skill.status === 'verified') {
        skill.status = 'quarantined'
        store.update(skill)
      }
      return store.get(id)
    }
  }

  // never resurrect a skill that was concurrently demoted out of 'verified'.
  if (skill.status !== 'verified') return skill
  const newUses = skill.uses + 1
  skill.successRate = (skill.successRate * skill.uses + (outcome === 'success' ? 1 : 0)) / newUses
  skill.uses = newUses
  skill.utilityScore = utilityScore(skill, store.distinctRetrievalTasks(id))
  store.update(skill)
  return store.get(id)
}

// Re-tier verified positive skills by utility. Top `hotCap` -> hot, next 3x -> warm,
// remainder -> cold. Tier is a PERFORMANCE HINT: any verified skill is callable regardless
// of tier. Pinned skills are always hot and never demoted (they bypass the cap).
export function retier(store: SkillStore, hotCap = DEFAULT_HOT_CAP): void {
  const verified = store.listByStatus('verified').filter((s) => s.kind === 'positive')
  const counts = store.allDistinctRetrievalCounts()
  const scored = verified
    .map((s) => ({ s, score: utilityScore(s, counts.get(s.id) ?? 0) }))
    .sort((a, b) => b.score - a.score)

  // one transaction for all N row updates (collapses N WAL fsyncs into 1; cuts the event-loop
  // stall this loop otherwise causes on every remember()/reinforce() at large verified-set size).
  store.tx(() => {
    let rank = 0
    for (const { s, score } of scored) {
      s.utilityScore = score
      if (s.pinned) {
        s.tier = 'hot'
        store.update(s)
        continue
      }
      s.tier = rank < hotCap ? 'hot' : rank < hotCap * 4 ? 'warm' : 'cold'
      store.update(s)
      rank++
    }
  })
}
