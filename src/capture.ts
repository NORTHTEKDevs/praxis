import type { Skill, SkillCost, Provenance } from './skill.ts'
import { EMBEDDER_VERSION } from './skill.ts'
import { computeCheckStrength } from './strength.ts'

export interface CaptureInput {
  name: string
  interface: string
  implementation: string
  acceptanceTest: string
  task: string
  model?: string
  parents?: string[]
  capabilities?: string[]
  cost?: SkillCost
  evidence?: string
  createdAt?: number
}

// Pure, deterministic: turn a solved task into a QUARANTINED skill candidate.
// Embedding is filled by U4 (dedup) and status is promoted by U2 (verify) -- capture
// never claims a skill works. checkStrength is computed at capture time and surfaced
// in stats so weak-test skills are visible.
export function captureSkill(input: CaptureInput): Skill {
  if (!input.name?.trim()) throw new Error('capture: name required')
  if (!input.implementation?.trim()) throw new Error('capture: implementation required')

  // bound field lengths so a misbehaving caller cannot write unbounded data.
  const TEXT = 2000
  const CODE = 50_000
  const provenance: Provenance = {
    task: (input.task ?? '').slice(0, TEXT),
    model: (input.model ?? 'unknown').slice(0, 200),
    parents: input.parents ?? [],
    createdAt: input.createdAt ?? Date.now(),
    evidence: (input.evidence ?? '').slice(0, TEXT),
  }

  return {
    id: '',
    name: input.name.trim().slice(0, 200),
    interface: (input.interface ?? '').slice(0, TEXT),
    implementation: input.implementation.slice(0, CODE),
    acceptanceTest: (input.acceptanceTest ?? '').slice(0, CODE),
    capabilities: input.capabilities ?? [],
    cost: input.cost ?? 'normal',
    provenance,
    embedding: [],
    embedderVersion: EMBEDDER_VERSION,
    utilityScore: 0,
    status: 'quarantined',
    version: 1,
    kind: 'positive',
    tier: 'hot',
    uses: 0,
    successRate: 1,
    pinned: false,
    checkStrength: computeCheckStrength(input.acceptanceTest ?? ''),
  }
}
