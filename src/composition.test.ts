import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseCalls } from './composition.ts'

describe('parseCalls', () => {
  test('detects single and double quoted call() names', () => {
    assert.deepEqual(parseCalls(`return call('double', input)`), ['double'])
    assert.deepEqual(parseCalls(`return call("double", input)`), ['double'])
  })

  test('detects backtick template-literal call() (no composition bypass)', () => {
    assert.deepEqual(parseCalls('return call(`double`, input)'), ['double'])
  })

  test('detects multiple distinct sub-skill calls', () => {
    assert.deepEqual(parseCalls(`return call("a", x) + call("b", y)`).sort(), ['a', 'b'])
  })

  test('ignores call() inside a line comment (no phantom dependency)', () => {
    assert.deepEqual(parseCalls(`// call("helper") old API\nreturn input * 2`), [])
  })

  test('ignores call() inside a block comment', () => {
    assert.deepEqual(parseCalls(`/* uses call("helper") */ return input`), [])
  })

  test('ignores call() inside a string literal', () => {
    assert.deepEqual(parseCalls(`const msg = "call('foo', x)"; return input`), [])
  })

  test('does not match a substring like recall(', () => {
    assert.deepEqual(parseCalls(`return recall("x")`), [])
  })

  test('plain leaf code has no calls', () => {
    assert.deepEqual(parseCalls('return input * 2'), [])
  })
})
