import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { verifySkill } from './verify.ts'

const mk = (implementation: string, acceptanceTest: string) => ({ implementation, acceptanceTest })

// The property tests for the trust-critical invariant: no adversarial input promotes a
// skill to `verified`. If any of these regress, verify-before-keep is broken.
describe('verify gate adversarial suite', () => {
  test('assert-swallowing via try/catch does NOT verify', async () => {
    // The acceptance test wraps a failing assert in try/catch to hide the failure.
    // The sandbox records the failure before throwing, so the host still sees it.
    const r = await verifySkill(mk('return 1', 'try { assert(run(1) === 999) } catch (e) {}'))
    assert.notEqual(r.status, 'verified')
  })

  test('memory allocation bomb does not crash host; quarantined', async () => {
    const r = await verifySkill(
      mk('const a=[]; while(true){ a.push(new Array(100000).fill(0)) }', 'assert(run(1) === 1)'),
      { timeoutMs: 1500 },
    )
    assert.equal(r.status, 'quarantined')
  })

  test('run redefinition attempt does not verify', async () => {
    const r = await verifySkill(mk('run = () => 42; return 1', 'assert(run(1) === 1)'))
    assert.notEqual(r.status, 'verified')
  })

  test('50 rapid verifications all complete (no worker leak)', async () => {
    const results: string[] = []
    for (let i = 0; i < 50; i++) {
      results.push((await verifySkill(mk('return input * 2', 'assert(run(2) === 4)'))).status)
    }
    assert.equal(results.length, 50)
    assert.ok(results.every((s) => s === 'verified'))
  })
})
