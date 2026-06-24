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

  test('near-dup of a quarantined skill is a duplicate (not inserted, utility NOT bumped)', async () => {
    const a = await maybeMerge(store, cand('reverse-string', '(s:string)->string', 'reverse a string'), embedder)
    assert.equal(a.action, 'inserted')
    const b = await maybeMerge(store, cand('reverse-string', '(s:string)->string', 'reverse a string'), embedder)
    assert.equal(b.action, 'duplicate')
    assert.equal(b.id, a.id)
    assert.equal(store.all().length, 1)
    assert.equal(store.get(a.id)?.utilityScore, 0)
  })

  test('near-dup of a verified skill is reinforced (utility bumped)', async () => {
    const a = await maybeMerge(store, cand('reverse-string', '(s:string)->string', 'reverse a string'), embedder)
    store.updateStatus(a.id, 'verified')
    const b = await maybeMerge(store, cand('reverse-string', '(s:string)->string', 'reverse a string'), embedder)
    assert.equal(b.action, 'reinforced')
    assert.equal(store.all().length, 1)
    assert.ok((store.get(a.id)?.utilityScore ?? 0) > 0)
  })

  test('unrelated candidates are both inserted', async () => {
    await maybeMerge(store, cand('reverse-string', '(s:string)->string', 'reverse a string'), embedder)
    await maybeMerge(store, cand('sum-array', '(xs:number[])->number', 'sum an array of numbers'), embedder)
    assert.equal(store.all().length, 2)
  })
})
