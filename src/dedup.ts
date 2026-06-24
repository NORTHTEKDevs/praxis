import type { Skill } from './skill.ts'
import type { Embedder } from './embedder.ts'
import { cosine } from './embedder.ts'
import { SkillStore } from './store.ts'

export type DedupAction = 'inserted' | 'reinforced'

export interface DedupResult {
  action: DedupAction
  id: string
  cosine: number
}

function skillText(s: Pick<Skill, 'name' | 'interface' | 'provenance'>): string {
  return `${s.name} ${s.interface} ${s.provenance.task}`
}

function interfaceCompatible(a: Skill, b: Skill): boolean {
  // v1: identical declared interface counts as compatible
  return a.interface.trim() === b.interface.trim()
}

// Write-time dedup: embed the candidate, compare to existing skills, and if a
// near-duplicate with a compatible interface exists, REINFORCE it instead of
// inserting a duplicate. This is cost-control mechanism #2 (fight library bloat
// at the source).
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
    const sim = cosine(emb, s.embedding)
    if (!best || sim > best.sim) best = { skill: s, sim }
  }

  if (best && best.sim >= threshold && interfaceCompatible(best.skill, candidate)) {
    best.skill.utilityScore += 1
    store.update(best.skill)
    return { action: 'reinforced', id: best.skill.id, cosine: best.sim }
  }

  const id = store.insert(candidate)
  return { action: 'inserted', id, cosine: best?.sim ?? 0 }
}
