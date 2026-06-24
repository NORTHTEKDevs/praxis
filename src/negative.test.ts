import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SkillStore } from './store.ts'
import { HashingEmbedder } from './embedder.ts'
import { recordFailure } from './negative.ts'
import { recall } from './retrieve.ts'
import { captureSkill } from './capture.ts'

const embedder = new HashingEmbedder()

describe('negative skills', () => {
  let store: SkillStore
  beforeEach(() => {
    store = new SkillStore(':memory:')
  })

  test('recordFailure inserts a verified negative with empty impl/test and the reason', async () => {
    const id = await recordFailure(store, embedder, {
      task: 'parse nested json',
      approach: 'regex',
      reason: 'regex fails on depth > 2',
    })
    const s = store.get(id)
    assert.equal(s?.kind, 'negative')
    assert.equal(s?.status, 'verified')
    assert.equal(s?.implementation, '')
    assert.equal(s?.acceptanceTest, '')
    assert.equal(s?.provenance.evidence, 'regex fails on depth > 2')
  })

  test('recall surfaces a relevant negative with its reason', async () => {
    await recordFailure(store, embedder, {
      task: 'parse nested json',
      approach: 'regex',
      reason: 'regex fails on depth > 2',
    })
    const r = await recall(store, embedder, 'parse nested json', { k: 5 })
    assert.equal(r.negatives.length, 1)
    assert.equal(r.negatives[0].provenance.evidence, 'regex fails on depth > 2')
  })

  test('negatives are returned in a separate list, not interleaved with positives', async () => {
    const p = captureSkill({ name: 'json-parser', interface: '(s)->o', implementation: 'return input', acceptanceTest: 'assert(run(1) === 1)', task: 'parse nested json' })
    p.embedding = await embedder.embed('json-parser (s)->o parse nested json')
    p.status = 'verified'
    store.insert(p)
    await recordFailure(store, embedder, { task: 'parse nested json', approach: 'regex', reason: 'fails on depth > 2' })
    const r = await recall(store, embedder, 'parse nested json', { k: 5 })
    assert.ok(r.selected.every((s) => s.kind === 'positive'))
    assert.ok(r.negatives.every((s) => s.kind === 'negative'))
    assert.equal(r.negatives.length, 1)
  })
})
