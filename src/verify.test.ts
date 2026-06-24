import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { verifySkill } from './verify.ts'

const mk = (implementation: string, acceptanceTest: string) => ({ implementation, acceptanceTest })

describe('verifySkill (fail-closed verify-before-keep)', () => {
  test('verifies when acceptance holds', () => {
    assert.equal(verifySkill(mk('return input * 2', 'assert(run(3) === 6)')).status, 'verified')
  })

  test('refutes when acceptance fails', () => {
    assert.equal(verifySkill(mk('return input * 2', 'assert(run(3) === 7)')).status, 'refuted')
  })

  test('quarantines on timeout (infinite loop)', () => {
    const r = verifySkill(mk('while(true){}', 'assert(run(1) === 1)'), { timeoutMs: 300 })
    assert.equal(r.status, 'quarantined')
    assert.match(r.reason ?? '', /timed out/i)
  })

  test('quarantines on thrown runtime error', () => {
    assert.equal(
      verifySkill(mk('throw new Error("boom")', 'assert(run(1) === 1)')).status,
      'quarantined',
    )
  })

  test('never verifies without an acceptance test', () => {
    assert.notEqual(verifySkill(mk('return 1', '')).status, 'verified')
  })

  test('property: verified requires a real run + passing check (string skill)', () => {
    const r = verifySkill(mk('return input.split("").reverse().join("")', 'assert(run("ab") === "ba")'))
    assert.equal(r.status, 'verified')
  })
})
