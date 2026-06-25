import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseCalls, resolveComposition } from './composition.ts'

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

  test('detects call() hidden inside a template-literal interpolation', () => {
    assert.deepEqual(parseCalls('return `${call("hidden", x)}`'), ['hidden'])
  })

  test('handles braces nested inside an interpolation without losing later calls', () => {
    assert.deepEqual(parseCalls('return `${ {a:1} }` + call("real", x)'), ['real'])
  })

  test('detects a dependency after a division operator (no silent drop)', () => {
    assert.deepEqual(parseCalls('return x / call("dep")'), ['dep'])
    assert.deepEqual(parseCalls('return x/call("dep")'), ['dep'])
  })

  test('call() inside a regex literal is a fail-closed false positive (documented v1 limit)', () => {
    // accepted: skill code should not contain call( inside a regex. It is flagged as a dep,
    // which quarantines the skill (safe) rather than silently dropping a real dependency.
    assert.deepEqual(parseCalls('return /call("x")/.test(input) ? 1 : 0'), ['x'])
  })
})

describe('resolveComposition', () => {
  test('resolves a diamond DAG once per node (no exponential blowup)', () => {
    // A -> B,C ; B -> D ; C -> D ; D -> leaf. D is reachable via two paths but must resolve once.
    const impls: Record<string, string> = {
      B: 'return call("D", input)',
      C: 'return call("D", input)',
      D: 'return call("leaf", input)',
      leaf: 'return input',
    }
    let lookups = 0
    const store = {
      findVerifiedByName(name: string) {
        lookups++
        return name in impls ? { id: name, name, implementation: impls[name], capabilities: [] } : undefined
      },
    } as never
    const r = resolveComposition(store, 'return call("B", input) + call("C", input)', [], 5)
    assert.ok(r.ok)
    // 4 unique nodes (B, C, D, leaf). Without the global resolved-set, D + leaf re-resolve via
    // both B and C -> >4 lookups (6). With it, exactly one lookup per unique node.
    assert.ok(lookups <= 4, `expected <= 4 lookups, got ${lookups}`)
    assert.equal(r.deps.length, 4)
  })

  test('still detects a true cycle (resolved-set does not mask it)', () => {
    const impls: Record<string, string> = { B: 'return call("A", input)' }
    const store = {
      findVerifiedByName(name: string) {
        return name in impls || name === 'A' ? { id: name, name, implementation: impls[name] ?? 'return call("B", input)', capabilities: [] } : undefined
      },
    } as never
    const r = resolveComposition(store, 'return call("A", input)', [], 5)
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /cyclic/)
  })
})
