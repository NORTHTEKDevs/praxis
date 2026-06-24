import { runAcceptance } from './sandbox.ts'
import type { SkillStatus } from './skill.ts'

export interface VerifyInput {
  implementation: string
  acceptanceTest: string
}

export interface VerifyResult {
  status: SkillStatus
  reason?: string
}

// Verify-before-keep (fail-closed). A skill becomes `verified` ONLY when its
// acceptance test actually executed and passed. Everything else degrades safely:
//   - no acceptance test        -> quarantined (never trusted on say-so)
//   - acceptance assertion fails -> refuted
//   - runtime error / timeout    -> quarantined
export function verifySkill(skill: VerifyInput, opts: { timeoutMs?: number } = {}): VerifyResult {
  if (!skill.acceptanceTest || !skill.acceptanceTest.trim()) {
    return { status: 'quarantined', reason: 'no acceptance test' }
  }
  const r = runAcceptance(skill.implementation, skill.acceptanceTest, opts.timeoutMs ?? 2000)
  if (r.ok) return { status: 'verified' }
  if (r.category === 'assertion') return { status: 'refuted', reason: r.error }
  return { status: 'quarantined', reason: r.error }
}
