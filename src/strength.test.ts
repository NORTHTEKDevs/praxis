import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeCheckStrength } from './strength.ts'

describe('computeCheckStrength', () => {
  test('run(...) vs a concrete literal scores 1', () => {
    assert.equal(computeCheckStrength('assert(run(3) === 6)'), 1)
    assert.equal(computeCheckStrength('assert(run("ab") === "ba")'), 1)
  })

  test('two real assertions score 2', () => {
    assert.equal(computeCheckStrength('assert(run(3) === 6); assert(run(0) === 0)'), 2)
  })

  test('literal-vs-literal scores 0 (implementation never exercised)', () => {
    assert.equal(computeCheckStrength('assert("a" === "a")'), 0)
    assert.equal(computeCheckStrength('assert(1 === 1)'), 0)
  })

  test('self-referential run-vs-run scores 0', () => {
    assert.equal(computeCheckStrength('assert(run(1) === run(1))'), 0)
  })

  test('content-free assert(true) scores 0', () => {
    assert.equal(computeCheckStrength('assert(true)'), 0)
    assert.equal(computeCheckStrength(''), 0)
  })

  test('multiline assert body still scores correctly', () => {
    assert.equal(computeCheckStrength('assert(\n  run(3) === 6\n)'), 1)
  })

  test('a wrapped run(...) oracle is recognized (not false-quarantined)', () => {
    assert.equal(computeCheckStrength('assert(JSON.stringify(run(3)) === "[1,2,3]")'), 1)
    assert.equal(computeCheckStrength('assert(String(run(3)) === "6")'), 1)
  })

  test('a different identifier ending in run( does not count as run()', () => {
    assert.equal(computeCheckStrength('assert(myrun(3) === 6)'), 0)
  })
})
