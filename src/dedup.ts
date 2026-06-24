import type { Skill } from './skill.ts'
import type { Embedder } from './embedder.ts'
import { cosine } from './embedder.ts'
import { SkillStore } from './store.ts'

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

  const existing = [...store.listByStatus('verified'), ...store.listByStatus('quarantined')]
  let best: { skill: Skill; sim: number } | null = null
  for (const s of existing) {
    if (s.embedding.length === 0) continue
    if (s.embedderVersion !== candidate.embedderVersion) continue
    const sim = cosine(emb, s.embedding)
    if (!best || sim > best.sim) best = { skill: s, sim }
  }

  if (best && best.sim >= threshold && interfaceCompatible(best.skill, candidate)) {
    if (best.skill.status === 'verified') {
      best.skill.utilityScore += 1
      store.update(best.skill)
      return { action: 'reinforced', id: best.skill.id, cosine: best.sim }
    }
    return { action: 'duplicate', id: best.skill.id, cosine: best.sim }
  }

  const id = store.insert(candidate)
  return { action: 'inserted', id, cosine: best?.sim ?? 0 }
}
