import type { Skill, SkillCost, Provenance, SkillKind } from './skill.ts'
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
  kind?: SkillKind
}

// Pure, deterministic: turn a solved task into a QUARANTINED skill candidate.
// Embedding is filled by U4 (dedup) and status is promoted by U2 (verify) -- capture
// never claims a skill works. checkStrength is computed at capture time and surfaced
// in stats so weak-test skills are visible.
export function captureSkill(input: CaptureInput): Skill {
  if (!input.name?.trim()) throw new Error('capture: name required')
  if (!input.implementation?.trim()) throw new Error('capture: implementation required')

  const provenance: Provenance = {
    task: input.task ?? '',
    model: input.model ?? 'unknown',
    parents: input.parents ?? [],
    createdAt: input.createdAt ?? 0,
    evidence: input.evidence ?? '',
  }

  return {
    id: '',
    name: input.name.trim(),
    interface: input.interface ?? '',
    implementation: input.implementation,
    acceptanceTest: input.acceptanceTest ?? '',
    capabilities: input.capabilities ?? [],
    cost: input.cost ?? 'normal',
    provenance,
    embedding: [],
    embedderVersion: EMBEDDER_VERSION,
    utilityScore: 0,
    status: 'quarantined',
    version: 1,
    kind: input.kind ?? 'positive',
    tier: 'hot',
    uses: 0,
    successRate: 1,
    pinned: false,
    checkStrength: computeCheckStrength(input.acceptanceTest ?? ''),
  }
}
