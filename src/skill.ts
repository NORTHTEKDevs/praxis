export type SkillStatus = 'quarantined' | 'verified' | 'refuted' | 'archived'
export type SkillCost = 'cheap' | 'normal' | 'expensive'

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
  utilityScore: number
  status: SkillStatus
  version: number
}
