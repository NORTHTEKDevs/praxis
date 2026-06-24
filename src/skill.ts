export type SkillStatus = 'quarantined' | 'verified' | 'refuted' | 'archived'
export type SkillCost = 'cheap' | 'normal' | 'expensive'
export type SkillKind = 'positive' | 'negative'
export type SkillTier = 'hot' | 'warm' | 'cold'

export const EMBEDDER_VERSION = 'hashing-v1'

export interface Provenance {
  task: string
  model: string
  parents: string[]
  createdAt: number
  evidence: string
}

export interface Skill {
  id: string
  name: string
  interface: string
  implementation: string
  acceptanceTest: string
  capabilities: string[]
  cost: SkillCost
  provenance: Provenance
  embedding: number[]
  embedderVersion: string
  utilityScore: number
  status: SkillStatus
  version: number
  // hardening: fields U5-U11 depend on, added up front to avoid a breaking migration
  kind: SkillKind
  tier: SkillTier
  uses: number
  successRate: number
  pinned: boolean
  checkStrength: number
}
