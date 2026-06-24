import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SkillStore } from './store.ts'
import { HashingEmbedder } from './embedder.ts'
import { consolidate, reindex } from './consolidate.ts'
import { captureSkill } from './capture.ts'
import type { SkillTier } from './skill.ts'

const embedder = new HashingEmbedder()

interface DupOpts {
  name?: string
  impl?: string
  test?: string
  tier?: SkillTier
  utility?: number
  pinned?: boolean
  embedderVersion?: string
}

async function addVerified(store: SkillStore, o: DupOpts = {}): Promise<string> {
  const s = captureSkill({
    name: o.name ?? 'reverse',
    interface: '(s)->s',
    implementation: o.impl ?? 'return input.split("").reverse().join("")',
    acceptanceTest: o.test ?? 'assert(run("ab") === "ba")',
    task: 'reverse a string',
  })
  s.embedding = await embedder.embed(`${s.name} ${s.interface} ${s.provenance.task}`)
  s.status = 'verified'
  if (o.tier) s.tier = o.tier
  if (o.utility !== undefined) s.utilityScore = o.utility
  if (o.pinned) s.pinned = true
  if (o.embedderVersion) s.embedderVersion = o.embedderVersion
  return store.insert(s)
}

describe('consolidate + reindex', () => {
  let store: SkillStore
  beforeEach(() => {
    store = new SkillStore(':memory:')
  })

  const verifiedCount = () => store.listByStatus('verified').filter((s) => s.kind === 'positive').length

  test('folds a cluster of >= 3 near-duplicates (regression-safe)', async () => {
    await addVerified(store)
    await addVerified(store)
    await addVerified(store)
    const r = await consolidate(store, embedder)
    assert.equal(r.merged, 2)
    assert.equal(verifiedCount(), 1)
  })

  test('a 2-duplicate cluster is flagged, not merged', async () => {
    await addVerified(store)
    await addVerified(store)
    const r = await consolidate(store, embedder)
    assert.equal(r.merged, 0)
    assert.ok(r.flagged >= 1)
    assert.equal(verifiedCount(), 2)
  })

  test('eviction archives cold low-utility unpinned skills; pinned survive', async () => {
    await addVerified(store, { name: 'lone-a', impl: 'return 1', test: 'assert(run(1) === 1)', tier: 'cold', utility: 0 })
    const pinned = await addVerified(store, { name: 'lone-b', impl: 'return 2', test: 'assert(run(1) === 2)', tier: 'cold', utility: 0, pinned: true })
    const r = await consolidate(store, embedder)
    assert.ok(r.evicted >= 1)
    assert.equal(store.get(pinned)?.status, 'verified')
  })

  test('dryRun reports counts but mutates nothing', async () => {
    await addVerified(store)
    await addVerified(store)
    await addVerified(store)
    const before = store.all().length
    const r = await consolidate(store, embedder, { dryRun: true })
    assert.equal(r.merged, 2)
    assert.equal(store.all().length, before)
    assert.equal(verifiedCount(), 3)
  })

  test('mutex rejects an overlapping consolidate', async () => {
    await addVerified(store)
    await addVerified(store)
    await addVerified(store)
    const p1 = consolidate(store, embedder)
    await assert.rejects(consolidate(store, embedder), /in progress/)
    await p1
  })

  test('reindex re-embeds all skills and stamps the current embedder version', async () => {
    await addVerified(store, { embedderVersion: 'legacy-v0' })
    await addVerified(store, { name: 'other', impl: 'return 1', test: 'assert(run(1) === 1)', embedderVersion: 'legacy-v0' })
    const n = await reindex(store, embedder)
    assert.equal(n, 2)
    assert.ok(store.all().every((s) => s.embedderVersion === 'hashing-v1'))
  })

  test('merges a cluster of COMPOSED keepers (resolves sub-skills before verify)', async () => {
    await addVerified(store, { name: 'leaf', impl: 'return input + "!"', test: 'assert(run("a") === "a!")' })
    for (let i = 0; i < 3; i++) {
      await addVerified(store, { name: 'composed', impl: 'return call("leaf", input)', test: 'assert(run("a") === "a!")' })
    }
    const r = await consolidate(store, embedder)
    assert.ok(r.merged >= 2)
  })

  test('flags a cluster whose keeper references a missing sub-skill (no unsafe merge)', async () => {
    for (let i = 0; i < 3; i++) {
      await addVerified(store, { name: 'broken', impl: 'return call("missing", input)', test: 'assert(run("a") === "a")' })
    }
    const before = verifiedCount()
    const r = await consolidate(store, embedder)
    assert.ok(r.flagged >= 1)
    assert.equal(verifiedCount(), before)
  })
})
