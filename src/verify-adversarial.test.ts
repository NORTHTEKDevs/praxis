import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { verifySkill } from './verify.ts'

const mk = (implementation: string, acceptanceTest: string) => ({ implementation, acceptanceTest })

// The property tests for the trust-critical invariant: no adversarial input promotes a
// skill to `verified`. If any of these regress, verify-before-keep is broken.
describe('verify gate adversarial suite', () => {
  test('assert-swallowing via try/catch is refuted, not verified', async () => {
    // The acceptance test wraps a failing assert in try/catch to hide the failure.
    // The sandbox records the failure before throwing, so the host still sees it.
    const r = await verifySkill(mk('return 1', 'try { assert(run(1) === 999) } catch (e) {}'))
    assert.equal(r.status, 'refuted')
  })

  test('memory allocation bomb does not crash host; quarantined', async () => {
    const r = await verifySkill(
      mk('const a=[]; while(true){ a.push(new Array(100000).fill(0)) }', 'assert(run(1) === 1)'),
      { timeoutMs: 1500 },
    )
    assert.equal(r.status, 'quarantined')
  })

  test('run redefinition cannot forge the acceptance result', async () => {
    // The implementation tries to reassign run() to return 999 so a 999-check passes.
    // The acceptance test's run() is the fixed outer run; the reassignment is a harmless
    // global, so the real result (input) is checked -> refuted, not verified.
    const r = await verifySkill(mk('run = () => 999; return input', 'assert(run(3) === 999)'))
    // rejected either way (the real outer run() is unaffected -> assertion fails, or the
    // reassignment errors) - the invariant is simply: NOT verified.
    assert.ok(r.status === 'quarantined' || r.status === 'refuted')
  })

  test('a tampering acceptance test cannot spoof a pass', async () => {
    // swallow a failing assert, then try to clear the (now closure-private) failure record.
    const r = await verifySkill(mk('return 1', 'try { assert(run(1) === 999) } catch (e) {} __af = []; __ac = 99'))
    assert.equal(r.status, 'refuted') // closure preserves the recorded failure; tamper is inert
  })

  test('a short-circuit-tautology acceptance test does not verify (counter-example probe)', async () => {
    // run(3) === 6 is false, but `|| true` makes the assert pass regardless of the impl.
    const r = await verifySkill(mk('return 0', 'assert(run(3) === 6 || true)'))
    assert.notEqual(r.status, 'verified')
  })

  test('an acceptance test that ignores run() entirely does not verify', async () => {
    const r = await verifySkill(mk('return 0', 'assert(run(3) === run(3) + 0 || 1 === 1)'))
    assert.notEqual(r.status, 'verified')
  })

  test('100 rapid verifications all complete (no worker leak)', async () => {
    const results: string[] = []
    for (let i = 0; i < 100; i++) {
      results.push((await verifySkill(mk('return input * 2', 'assert(run(2) === 4)'))).status)
    }
    assert.equal(results.length, 100)
    assert.ok(results.every((s) => s === 'verified'))
  })
})
