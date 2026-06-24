import type { Skill } from './skill.ts'
import type { Embedder } from './embedder.ts'
import { cosine } from './embedder.ts'
import { SkillStore } from './store.ts'
import { recencyDecay } from './utility.ts'

export interface RecallOptions {
  k?: number
  tokenBudget?: number
  negativeThreshold?: number
  maxNegatives?: number
}

export interface RecallResult {
  selected: Skill[]
  negatives: Skill[]
  costEstimate: number
  retrievalMs: number
}

function estTokens(s: Skill): number {
  const text = s.name + s.interface + s.implementation + s.acceptanceTest
  return Math.max(1, Math.ceil(text.length / 4))
}

// Budgeted top-k retrieval.
// CONTEXT-cost is O(k) tokens, bounded by tokenBudget, INDEPENDENT of library size.
// COMPUTE-cost is O(hot-set size) comparisons, bounded by the U7 hot-set cap (NOT O(1)).
// Negatives are returned in a SEPARATE, always-included slot so a known failure is never
// dropped to make room for positives under a tight budget.
export async function recall(
  store: SkillStore,
  embedder: Embedder,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallResult> {
  const k = opts.k ?? 5
  const start = Date.now()
  const q = (query ?? '').slice(0, 2000) // bound the O(n) embed + stored task
  const qemb = await embedder.embed(q)
  const verified = store.listByStatus('verified')

  const scored = verified
    .filter((s) => s.kind === 'positive' && s.tier === 'hot' && s.embedding.length > 0)
    .map((s) => ({
      s,
      score:
        cosine(qemb, s.embedding) *
        (1 + 0.2 * Math.log(1 + s.utilityScore)) *
        recencyDecay(s.provenance.createdAt),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)

  const selected: Skill[] = []
  let cost = 0
  for (const { s } of scored.slice(0, k)) {
    const t = estTokens(s)
    if (opts.tokenBudget !== undefined && selected.length > 0 && cost + t > opts.tokenBudget) break
    selected.push(s)
    cost += t
  }

  // Record retrievals so the `generality` dimension of the utility score reflects how many
  // distinct tasks a skill has served (otherwise it is permanently 0).
  for (const s of selected) store.recordRetrieval(s.id, q, Date.now())

  const negThreshold = opts.negativeThreshold ?? 0.7
  const negatives = verified
    .filter((s) => s.kind === 'negative' && s.embedding.length > 0)
    .map((s) => ({ s, sim: cosine(qemb, s.embedding) }))
    .filter((x) => x.sim > negThreshold)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, opts.maxNegatives ?? 1)
    .map((x) => x.s)

  for (const n of negatives) cost += estTokens(n)
  return { selected, negatives, costEstimate: cost, retrievalMs: Date.now() - start }
}
