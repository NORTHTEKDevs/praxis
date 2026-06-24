import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { captureSkill } from './capture.ts'

describe('captureSkill', () => {
  test('builds a well-formed quarantined candidate', () => {
    const s = captureSkill({
      name: 'double',
      interface: '(n:number)->number',
      implementation: 'return input * 2',
      acceptanceTest: 'assert(run(2) === 4)',
      task: 'double a number',
    })
    assert.equal(s.status, 'quarantined')
    assert.equal(s.version, 1)
    assert.equal(s.utilityScore, 0)
    assert.deepEqual(s.embedding, [])
    assert.equal(s.name, 'double')
    assert.equal(s.provenance.task, 'double a number')
    assert.ok(s.provenance.createdAt > 0) // recency is live, not 0
  })

  test('throws without a name', () => {
    assert.throws(
      () => captureSkill({ name: '', interface: '', implementation: 'return 1', acceptanceTest: '', task: '' }),
      /name required/,
    )
  })

  test('throws without an implementation', () => {
    assert.throws(
      () => captureSkill({ name: 'x', interface: '', implementation: '', acceptanceTest: '', task: '' }),
      /implementation required/,
    )
  })

  test('defaults are sane', () => {
    const s = captureSkill({ name: 'x', interface: '', implementation: 'return 1', acceptanceTest: '', task: 't' })
    assert.equal(s.cost, 'normal')
    assert.equal(s.provenance.model, 'unknown')
    assert.deepEqual(s.capabilities, [])
  })

  test('field lengths are bounded', () => {
    const s = captureSkill({
      name: 'x'.repeat(300),
      interface: '',
      implementation: 'y'.repeat(60000),
      acceptanceTest: 'assert(run(1) === 1)',
      task: 'z'.repeat(3000),
    })
    assert.equal(s.name.length, 200)
    assert.equal(s.implementation.length, 50000)
    assert.equal(s.provenance.task.length, 2000)
  })
})
