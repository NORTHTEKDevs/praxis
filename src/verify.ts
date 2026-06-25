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

// String/number literals appearing in an acceptance test, as stub return expressions. An
// INEQUALITY oracle (run !== <literal>) is only rejected by a stub that actually returns that
// literal, so the probe must try the test's own literals -- a random value satisfies `!==` and
// would falsely look vacuous.
function literalsIn(at: string): string[] {
  const out = new Set<string>()
  // double / single / template strings (incl. a literal `$` like `$5`) + numbers. Skip
  // INTERPOLATED templates (${...}) -- their runtime value is not a static literal.
  // `return ${m[0]}` is valid JS for each captured form.
  for (const m of at.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|0[xX][0-9a-fA-F]+|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    if (m[0][0] === '`' && /(?<!\\)\$\{/.test(m[0])) continue // skip only UNescaped ${...} interpolation
    out.add(m[0])
  }
  // cap to bound worker spawning on a pathological many-literal test, but generous enough that a
  // real inequality oracle's target literal is never dropped.
  return [...out].slice(0, 32)
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
    // Counter-example probe: the oracle is NON-vacuous iff it REJECTS (via an assertion failure)
    // at least one WRONG output. For an equality oracle (run === V) a random value is wrong; for an
    // INEQUALITY oracle (run !== V) the wrong output is V itself -- so a single random stub is not
    // enough (a UUID trivially satisfies `!== null`, falsely flagging the test vacuous). Try a
    // DIVERSE stub set: marker-free random values (defeats sniff/guess) + common sentinels + the
    // literals appearing in the test. The skill verifies iff SOME stub is cleanly assertion-
    // rejected. A stub that PASSES proves nothing; a stub that crashes NON-assertion (probe
    // evasion or incidental) is inconclusive. If NO stub is cleanly rejected (all pass or all
    // crash), the test is vacuous or evading -> quarantine (fail-closed). Short-circuits on the
    // first clean rejection (usually the first stub).
    const stubVals = [
      JSON.stringify(randomUUID()),
      JSON.stringify(randomUUID()),
      'null',
      'undefined',
      '0',
      '""',
      'false',
      'true',
      'NaN',
      'Infinity',
      '[]',
      '({})',
      ...literalsIn(skill.acceptanceTest),
    ]
    let rejected = false
    for (const v of stubVals) {
      const p = await runAcceptance(`return ${v}`, skill.acceptanceTest, sopts)
      if (!p.ok && p.category === 'assertion') {
        rejected = true
        break
      }
    }
    if (!rejected) {
      return { status: 'quarantined', reason: 'acceptance test does not exercise the implementation (vacuous or probe-evading)' }
    }
    return { status: 'verified' }
  }
  if (r.category === 'assertion') return { status: 'refuted', reason: r.error }
  return { status: 'quarantined', reason: r.error }
}
