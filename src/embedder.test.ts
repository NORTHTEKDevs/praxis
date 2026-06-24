import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { HashingEmbedder, cosine } from './embedder.ts'

describe('embedder + cosine', () => {
  test('identical text -> cosine ~1', async () => {
    const e = new HashingEmbedder()
    const a = await e.embed('reverse a string')
    const b = await e.embed('reverse a string')
    assert.ok(cosine(a, b) > 0.999)
  })

  test('cosine returns 0 on dimension mismatch (no silent truncation)', () => {
    assert.equal(cosine([1, 0], [1, 0, 0]), 0)
  })

  test('disjoint text -> low cosine', async () => {
    const e = new HashingEmbedder()
    const a = await e.embed('reverse a string')
    const b = await e.embed('sum an array of numbers')
    assert.ok(cosine(a, b) < 0.5)
  })

  test('empty vectors -> 0 not NaN', () => {
    assert.equal(cosine([], []), 0)
  })
})
