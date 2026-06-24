import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SkillStore } from './store.ts'
import { HashingEmbedder } from './embedder.ts'
import { maybeMerge } from './dedup.ts'
import { captureSkill } from './capture.ts'

describe('maybeMerge (dedup on write)', () => {
  let store: SkillStore
  const embedder = new HashingEmbedder()
  beforeEach(() => {
    store = new SkillStore(':memory:')
  })

  const cand = (name: string, iface: string, task: string) =>
    captureSkill({
      name,
      interface: iface,
      implementation: 'return input',
      acceptanceTest: 'assert(run(1) === 1)',
      task,
    })

  test('near-identical candidate is reinforced, not duplicated', async () => {
    const a = await maybeMerge(store, cand('reverse-string', '(s:string)->string', 'reverse a string'), embedder)
    assert.equal(a.action, 'inserted')
    const b = await maybeMerge(store, cand('reverse-string', '(s:string)->string', 'reverse a string'), embedder)
    assert.equal(b.action, 'reinforced')
    assert.equal(b.id, a.id)
    assert.equal(store.all().length, 1)
  })

  test('unrelated candidates are both inserted', async () => {
    await maybeMerge(store, cand('reverse-string', '(s:string)->string', 'reverse a string'), embedder)
    await maybeMerge(store, cand('sum-array', '(xs:number[])->number', 'sum an array of numbers'), embedder)
    assert.equal(store.all().length, 2)
  })

  test('reinforce bumps utility on the kept skill', async () => {
    const a = await maybeMerge(store, cand('reverse-string', '(s:string)->string', 'reverse a string'), embedder)
    await maybeMerge(store, cand('reverse-string', '(s:string)->string', 'reverse a string'), embedder)
    assert.ok((store.get(a.id)?.utilityScore ?? 0) > 0)
  })
})
