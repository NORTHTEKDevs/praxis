import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { verifySkill } from './verify.ts'

const mk = (implementation: string, acceptanceTest: string) => ({ implementation, acceptanceTest })

describe('verifySkill (fail-closed verify-before-keep)', () => {
  test('verifies when acceptance holds', async () => {
    assert.equal((await verifySkill(mk('return input * 2', 'assert(run(3) === 6)'))).status, 'verified')
  })

  test('refutes when acceptance fails', async () => {
    assert.equal((await verifySkill(mk('return input * 2', 'assert(run(3) === 7)'))).status, 'refuted')
  })

  test('quarantines on timeout (infinite loop)', async () => {
    const r = await verifySkill(mk('while(true){}', 'assert(run(1) === 1)'), { timeoutMs: 300 })
    assert.equal(r.status, 'quarantined')
    assert.match(r.reason ?? '', /timed out/i)
  })

  test('quarantines on thrown runtime error', async () => {
    assert.equal((await verifySkill(mk('throw new Error("boom")', 'assert(run(1) === 1)'))).status, 'quarantined')
  })

  test('never verifies without an acceptance test', async () => {
    assert.notEqual((await verifySkill(mk('return 1', ''))).status, 'verified')
  })

  test('property: verified requires a real run + passing check (string skill)', async () => {
    const r = await verifySkill(mk('return input.split("").reverse().join("")', 'assert(run("ab") === "ba")'))
    assert.equal(r.status, 'verified')
  })

  test('rejects async skill (vacuous-pass guard)', async () => {
    const r = await verifySkill(mk('return Promise.resolve(6)', 'assert(run(3) === 6)'))
    assert.equal(r.status, 'quarantined')
  })

  test('quarantines weak test: assert(true)', async () => {
    const r = await verifySkill(mk('return 1', 'assert(true)'))
    assert.equal(r.status, 'quarantined')
    assert.match(r.reason ?? '', /weak/i)
  })

  test('quarantines self-referential test', async () => {
    const r = await verifySkill(mk('return 7', 'assert(run(1) === run(1))'))
    assert.equal(r.status, 'quarantined')
  })
})
