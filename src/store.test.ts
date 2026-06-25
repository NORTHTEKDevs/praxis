import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
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
  embedderVersion: 'hashing-v1',
  utilityScore: 0,
  status: 'quarantined',
  version: 1,
  kind: 'positive',
  tier: 'hot',
  uses: 0,
  successRate: 1,
  pinned: false,
  checkStrength: 1,
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

  test('all hardening fields round-trip', () => {
    const id = store.insert(
      mk({ embedding: [0.5, 0.6, 0.7], kind: 'negative', tier: 'cold', uses: 3, successRate: 0.5, pinned: true, checkStrength: 2 }),
    )
    const got = store.get(id)
    assert.deepEqual(got?.embedding, [0.5, 0.6, 0.7])
    assert.equal(got?.kind, 'negative')
    assert.equal(got?.tier, 'cold')
    assert.equal(got?.uses, 3)
    assert.equal(got?.successRate, 0.5)
    assert.equal(got?.pinned, true)
    assert.equal(got?.checkStrength, 2)
  })

  test('listByTier filters', () => {
    store.insert(mk({ name: 'h', tier: 'hot' }))
    store.insert(mk({ name: 'c', tier: 'cold' }))
    assert.deepEqual(
      store.listByTier('cold').map((s) => s.name),
      ['c'],
    )
  })

  test('skill_deps and dependentsOf', () => {
    store.addDep('composed', 'leaf')
    assert.deepEqual(store.dependentsOf('leaf'), ['composed'])
  })

  test('skill_retrievals distinct task count', () => {
    store.recordRetrieval('s1', 'taskA', 1)
    store.recordRetrieval('s1', 'taskA', 2)
    store.recordRetrieval('s1', 'taskB', 3)
    assert.equal(store.distinctRetrievalTasks('s1'), 2)
  })

  test('delete cascades to retrievals and deps', () => {
    const id = store.insert(mk())
    store.recordRetrieval(id, 'taskA', 1)
    store.addDep('other', id)
    store.delete(id)
    assert.equal(store.get(id), undefined)
    assert.equal(store.distinctRetrievalTasks(id), 0)
    assert.deepEqual(store.dependentsOf(id), [])
  })

  test('findVerifiedByName returns only verified positive skills', () => {
    store.insert(mk({ name: 'foo', kind: 'negative', status: 'verified' }))
    assert.equal(store.findVerifiedByName('foo'), undefined)
    const id = store.insert(mk({ name: 'foo', status: 'verified' }))
    assert.equal(store.findVerifiedByName('foo')?.id, id)
  })

  test('listVerifiedNegatives is bounded by the limit and excludes positives', () => {
    for (let i = 0; i < 5; i++) store.insert(mk({ name: `neg${i}`, kind: 'negative', status: 'verified' }))
    store.insert(mk({ name: 'pos', status: 'verified' })) // positive must not appear
    assert.equal(store.listVerifiedNegatives(2).length, 2)
    assert.equal(store.listVerifiedNegatives().length, 5)
    assert.ok(store.listVerifiedNegatives().every((s) => s.kind === 'negative'))
  })

  test('tx commits on success and rolls back on throw', () => {
    const id = store.insert(mk({ name: 'tx1' }))
    store.tx(() => store.updateStatus(id, 'verified'))
    assert.equal(store.get(id)?.status, 'verified')
    assert.throws(() =>
      store.tx(() => {
        store.updateStatus(id, 'archived')
        throw new Error('boom')
      }),
    )
    assert.equal(store.get(id)?.status, 'verified') // rolled back, not archived
  })

  test('a corrupt JSON row degrades to sentinels instead of denying all reads', () => {
    const base = join(tmpdir(), 'praxis-corrupt-test.db')
    const clean = () => {
      for (const f of [base, base + '-wal', base + '-shm', base + '-journal']) {
        try {
          rmSync(f)
        } catch {}
      }
    }
    clean()
    const s1 = new SkillStore(base)
    const good = s1.insert(mk({ name: 'good', status: 'verified', embedding: [0.1, 0.2] }))
    const bad = s1.insert(mk({ name: 'bad', status: 'verified' }))
    s1.close()
    // corrupt the 'bad' row's embedding JSON out-of-band
    const raw = new DatabaseSync(base)
    raw.prepare('UPDATE skills SET embedding = ? WHERE id = ?').run('{not valid json', bad)
    raw.close()
    const s2 = new SkillStore(base)
    const all = s2.all() // must NOT throw despite the corrupt row
    const goodRow = s2.get(good)
    const badRow = s2.get(bad)
    s2.close()
    clean()
    assert.equal(all.length, 2)
    assert.deepEqual(goodRow?.embedding, [0.1, 0.2]) // intact row unaffected
    assert.deepEqual(badRow?.embedding, []) // corrupt JSON -> safe sentinel, not a throw
  })

  test('skills persist across reopen (named file)', () => {
    const base = join(tmpdir(), 'praxis-persist-test.db')
    const clean = () => {
      for (const f of [base, base + '-wal', base + '-shm', base + '-journal']) {
        try {
          rmSync(f)
        } catch {}
      }
    }
    clean()
    const s1 = new SkillStore(base)
    const id = s1.insert(mk({ embedding: [0.5, 0.6, 0.7], status: 'verified', pinned: true }))
    s1.close()
    const s2 = new SkillStore(base)
    const got = s2.get(id)
    s2.close()
    clean()
    assert.equal(got?.name, 'reverse')
    assert.equal(got?.status, 'verified')
    assert.equal(got?.pinned, true)
    assert.deepEqual(got?.embedding, [0.5, 0.6, 0.7])
  })
})
