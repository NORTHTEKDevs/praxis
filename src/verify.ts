import { runAcceptance } from './sandbox.ts'
import { computeCheckStrength } from './strength.ts'
import type { SkillStatus } from './skill.ts'

export interface VerifyInput {
  implementation: string
  acceptanceTest: string
}

export interface VerifyResult {
  status: SkillStatus
  reason?: string
}

// Verify-before-keep (fail-closed). A skill becomes `verified` ONLY when its acceptance
// test actually executed and passed in the isolated worker. Degrades safely otherwise:
//   - no acceptance test            -> quarantined
//   - acceptance test too weak       -> quarantined (no concrete oracle = garbage-in guard)
//   - acceptance assertion fails     -> refuted
//   - runtime error / timeout / OOM  -> quarantined
//   - async/Promise implementation   -> quarantined (would pass a truthiness check vacuously)
export async function verifySkill(
  skill: VerifyInput,
  opts: { timeoutMs?: number } = {},
): Promise<VerifyResult> {
  if (!skill.acceptanceTest || !skill.acceptanceTest.trim()) {
    return { status: 'quarantined', reason: 'no acceptance test' }
  }
  if (computeCheckStrength(skill.acceptanceTest) < 1) {
    return { status: 'quarantined', reason: 'acceptance test too weak (no concrete expected value)' }
  }
  const r = await runAcceptance(skill.implementation, skill.acceptanceTest, opts.timeoutMs ?? 2000)
  if (r.ok) return { status: 'verified' }
  if (r.category === 'assertion') return { status: 'refuted', reason: r.error }
  return { status: 'quarantined', reason: r.error }
}
