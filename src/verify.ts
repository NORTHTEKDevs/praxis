import { randomUUID } from 'node:crypto'
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
    // Counter-example probe: re-run the acceptance test against STUB implementations that ignore
    // the input and return an UNPREDICTABLE, marker-free value. The skill is vacuous UNLESS every
    // stub is cleanly REJECTED BY AN ASSERTION (the oracle catching the wrong value). A stub that
    // PASSES means the oracle ignores the implementation; a stub that fails by a NON-assertion
    // error (runtime/timeout/memory/async, or no assertion ran at all) means the test detected and
    // EVADED the probe -- e.g. it sniffed the stub's type and crashed instead of asserting. Both
    // are inconclusive, so fail-closed -> quarantine. Two independent random stubs also defeat
    // value-guessing and the fixed-marker sniff a single fixed stub allowed.
    const cleanlyRejected = async (val: string) => {
      const p = await runAcceptance(`return ${JSON.stringify(val)}`, skill.acceptanceTest, sopts)
      return !p.ok && p.category === 'assertion'
    }
    if (!(await cleanlyRejected(randomUUID())) || !(await cleanlyRejected(randomUUID()))) {
      return { status: 'quarantined', reason: 'acceptance test does not exercise the implementation (vacuous or probe-evading)' }
    }
    return { status: 'verified' }
  }
  if (r.category === 'assertion') return { status: 'refuted', reason: r.error }
  return { status: 'quarantined', reason: r.error }
}
