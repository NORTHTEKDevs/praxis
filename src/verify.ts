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
  opts: { timeoutMs?: number; subImpls?: Record<string, string>; maxDepth?: number } = {},
): Promise<VerifyResult> {
  if (!skill.acceptanceTest || !skill.acceptanceTest.trim()) {
    return { status: 'quarantined', reason: 'no acceptance test' }
  }
  if (computeCheckStrength(skill.acceptanceTest) < 1) {
    return { status: 'quarantined', reason: 'acceptance test too weak (no concrete expected value)' }
  }
  const sopts = { timeoutMs: opts.timeoutMs ?? 2000, subImpls: opts.subImpls, maxDepth: opts.maxDepth }
  const r = await runAcceptance(skill.implementation, skill.acceptanceTest, sopts)
  if (r.ok) {
    // Counter-example probe: re-run the acceptance test against a STUB implementation that
    // ignores the input. If it ALSO passes, the test does not actually exercise the
    // implementation (a vacuous/tautological oracle, e.g. `assert(run(x) === 6 || true)`),
    // so it must NOT verify. This catches the short-circuit-bypass class that a purely
    // syntactic strength check cannot.
    const probe = await runAcceptance('return ({ __praxisStub: true })', skill.acceptanceTest, sopts)
    if (probe.ok) return { status: 'quarantined', reason: 'acceptance test does not exercise the implementation (vacuous)' }
    return { status: 'verified' }
  }
  if (r.category === 'assertion') return { status: 'refuted', reason: r.error }
  return { status: 'quarantined', reason: r.error }
}
