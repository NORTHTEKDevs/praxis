import type { Skill } from './skill.ts'
import type { Embedder } from './embedder.ts'
import { cosine } from './embedder.ts'
import { SkillStore } from './store.ts'
import { utilityScore } from './utility.ts'

export type DedupAction = 'inserted' | 'reinforced' | 'duplicate'

export interface DedupResult {
  action: DedupAction
  id: string
  cosine: number
}

function skillText(s: Pick<Skill, 'name' | 'interface' | 'provenance'>): string {
  return `${s.name} ${s.interface} ${s.provenance.task}`
}

function interfaceCompatible(a: Skill, b: Skill): boolean {
  return a.interface.trim() === b.interface.trim()
}

// Write-time dedup (cost-control #2). Embed the candidate, compare to existing skills,
// and on a near-duplicate:
//   - if the match is VERIFIED -> reinforce it (bump utility), don't insert a duplicate
//   - if the match is unverified (quarantined) -> it's a duplicate; don't insert, but do
//     NOT bump utility (a flood of near-dups must not inflate an unproven skill's rank)
// Cross-embedder-version vectors are never compared (different geometric spaces).
export async function maybeMerge(
  store: SkillStore,
  candidate: Skill,
  embedder: Embedder,
  threshold = 0.92,
): Promise<DedupResult> {
  const emb = await embedder.embed(skillText(candidate))
  candidate.embedding = emb

  const bestOf = (skills: Skill[]): { skill: Skill; sim: number } | null => {
    let best: { skill: Skill; sim: number } | null = null
    for (const s of skills) {
      if (s.embedding.length === 0) continue
      if (s.embedderVersion !== candidate.embedderVersion) continue
      if (!interfaceCompatible(s, candidate)) continue
      const sim = cosine(emb, s.embedding)
      if (sim >= threshold && (!best || sim > best.sim)) best = { skill: s, sim }
    }
    return best
  }

  // Prefer a VERIFIED near-duplicate (a proven skill) over any quarantined one, regardless
  // of cosine ordering -> reinforce it (recompute its utility via the formula, not a raw +1).
  const verifiedBest = bestOf(store.listByStatus('verified'))
  if (verifiedBest) {
    verifiedBest.skill.uses += 1
    verifiedBest.skill.utilityScore = utilityScore(verifiedBest.skill, store.distinctRetrievalTasks(verifiedBest.skill.id))
    store.update(verifiedBest.skill)
    return { action: 'reinforced', id: verifiedBest.skill.id, cosine: verifiedBest.sim }
  }

  // No verified match. A quarantined near-duplicate only suppresses re-inserting ANOTHER
  // unverified candidate; a freshly VERIFIED candidate must still be inserted (it is proven,
  // the quarantined match is not).
  const quarBest = bestOf(store.listByStatus('quarantined'))
  if (quarBest && candidate.status !== 'verified') {
    return { action: 'duplicate', id: quarBest.skill.id, cosine: quarBest.sim }
  }

  const id = store.insert(candidate)
  return { action: 'inserted', id, cosine: (verifiedBest ?? quarBest)?.sim ?? 0 }
}
