import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SkillStore } from './store.ts'
import type { Skill } from './skill.ts'

const mk = (over: Partial<Skill> = {}): Skill => ({
  id: '',
  name: 'reverse',
  interface: '(s:string)->string',
  implementation: 'return input.split("").reverse().join("")',
  acceptanceTest: 'assert(run("ab")==="ba")',
  capabilities: [],
  cost: 'cheap',
  provenance: { task: 'reverse a string', model: 'test', parents: [], createdAt: 0, evidence: '' },
  embedding: [0.1, 0.2],
  utilityScore: 0,
  status: 'quarantined',
  version: 1,
  ...over,
})

describe('SkillStore', () => {
  let store: SkillStore
  beforeEach(() => {
    store = new SkillStore(':memory:')
  })

  test('insert returns id and round-trips', () => {
    const id = store.insert(mk())
    assert.ok(id)
    const got = store.get(id)
    assert.equal(got?.name, 'reverse')
    assert.equal(got?.status, 'quarantined')
  })

  test('updateStatus transitions verified', () => {
    const id = store.insert(mk())
    store.updateStatus(id, 'verified')
    assert.equal(store.get(id)?.status, 'verified')
  })

  test('listByStatus filters', () => {
    const a = store.insert(mk({ name: 'a' }))
    store.updateStatus(a, 'verified')
    store.insert(mk({ name: 'b' }))
    assert.deepEqual(
      store.listByStatus('verified').map((s) => s.name),
      ['a'],
    )
  })

  test('embedding + provenance survive round-trip', () => {
    const id = store.insert(mk({ embedding: [0.5, 0.6, 0.7] }))
    assert.deepEqual(store.get(id)?.embedding, [0.5, 0.6, 0.7])
  })
})
