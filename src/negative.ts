import { SkillStore } from './store.ts'
import type { Embedder } from './embedder.ts'
import type { Skill } from './skill.ts'
import { EMBEDDER_VERSION } from './skill.ts'

export interface FailureInput {
  task: string
  approach: string
  reason: string
}

// Record a first-class NEGATIVE skill (the founder's "negative memory" applied to skills).
//
// DESIGN DECISION: negative skills bypass the verify gate. They record OBSERVED behavior
// (an approach that failed), not PROPOSED capability (code that should work) -- there is no
// implementation to test, so the gate cannot meaningfully run. They are stored
// status='verified' so they surface in retrieval, and are returned by recall() in a
// SEPARATE slot ("known failure modes") before the agent retries. Trust source: the agent
// reporting the failure is the same agent operating the library (single-tenant, not a
// multi-tenant trust boundary).
export async function recordFailure(
  store: SkillStore,
  embedder: Embedder,
  input: FailureInput,
): Promise<string> {
  // bound the body fields so a misbehaving caller cannot write megabytes into SQLite.
  const MAX = 2000
  const task = (input.task ?? '').slice(0, MAX)
  const approach = (input.approach ?? '').slice(0, MAX)
  const reason = (input.reason ?? '').slice(0, MAX)
  const emb = await embedder.embed(`${task} ${approach}`)
  const skill: Skill = {
    id: '',
    name: `failure: ${approach}`.slice(0, 80),
    interface: '',
    implementation: '',
    acceptanceTest: '',
    capabilities: [],
    cost: 'cheap',
    provenance: { task, model: 'observed', parents: [], createdAt: Date.now(), evidence: reason },
    embedding: emb,
    embedderVersion: EMBEDDER_VERSION,
    utilityScore: 0,
    status: 'verified',
    version: 1,
    kind: 'negative',
    tier: 'hot',
    uses: 0,
    successRate: 1,
    pinned: false,
    checkStrength: 0,
  }
  return store.insert(skill)
}
