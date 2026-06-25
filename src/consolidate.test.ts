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
  iface?: string
  task?: string
}

async function addVerified(store: SkillStore, o: DupOpts = {}): Promise<string> {
  const s = captureSkill({
    name: o.name ?? 'reverse',
    interface: o.iface ?? '(s)->s',
    implementation: o.impl ?? 'return input.split("").reverse().join("")',
    acceptanceTest: o.test ?? 'assert(run("ab") === "ba")',
    task: o.task ?? 'reverse a string',
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

  test('merge-fold cascade-quarantines a composed dependent of a folded sub-skill', async () => {
    await addVerified(store, { name: 'leaf', impl: 'return input + "!"', test: 'assert(run("a") === "a!")', utility: 10 })
    await addVerified(store, { name: 'leaf', impl: 'return input + "!"', test: 'assert(run("a") === "a!")', utility: 10 })
    const lid = await addVerified(store, { name: 'leaf', impl: 'return input + "!"', test: 'assert(run("a") === "a!")', utility: 0 })
    const cid = await addVerified(store, { name: 'composer', impl: 'return call("leaf", input)', test: 'assert(run("a") === "a!")' })
    store.addDep(cid, lid)
    await consolidate(store, embedder)
    assert.equal(store.get(lid)?.status, 'archived')
    assert.equal(store.get(cid)?.status, 'quarantined')
  })

  test('cold-eviction cascade-quarantines a composed dependent of an evicted sub-skill', async () => {
    const sub = captureSkill({ name: 'sub', interface: '(s)->s', implementation: 'return input', acceptanceTest: 'assert(run("a") === "a")', task: 'sub' })
    sub.status = 'verified'
    sub.tier = 'cold'
    sub.utilityScore = 0
    sub.embedding = await embedder.embed('sub (s)->s sub')
    const subId = store.insert(sub)
    const comp = captureSkill({ name: 'comp', interface: '(s)->s', implementation: 'return call("sub", input)', acceptanceTest: 'assert(run("a") === "a")', task: 'comp' })
    comp.status = 'verified'
    comp.embedding = await embedder.embed('comp (s)->s comp')
    const compId = store.insert(comp)
    store.addDep(compId, subId)
    await consolidate(store, embedder)
    assert.equal(store.get(subId)?.status, 'archived')
    assert.equal(store.get(compId)?.status, 'quarantined')
  })

  test('a merge keeper is NOT cascade-quarantined by folding a sibling it depends on', async () => {
    const k = await addVerified(store, { name: 'k', impl: 'return input + "!"', test: 'assert(run("a") === "a!")', utility: 10 })
    const s1 = await addVerified(store, { name: 'k', impl: 'return input + "!"', test: 'assert(run("a") === "a!")', utility: 5 })
    await addVerified(store, { name: 'k', impl: 'return input + "!"', test: 'assert(run("a") === "a!")', utility: 0 })
    store.addDep(k, s1) // keeper depends (by id) on a sibling that will be folded
    await consolidate(store, embedder)
    assert.equal(store.get(k)?.status, 'verified')
  })

  test('a keeper demoted DURING the async verify window aborts the fold (siblings preserved)', async () => {
    const keeper = await addVerified(store, { name: 'm', impl: 'return input + "!"', test: 'assert(run("a") === "a!")', utility: 10 })
    const sib = await addVerified(store, { name: 'm', impl: 'return input + "!"', test: 'assert(run("a") === "a!")', utility: 5 })
    await addVerified(store, { name: 'm', impl: 'return input + "!"', test: 'assert(run("a") === "a!")', utility: 0 })
    // consolidate parks on its first verifySkill await; demote the keeper during that window
    // (a concurrent reinforce(keeper,'failure') analogue, which does not take the lock).
    const p = consolidate(store, embedder)
    store.updateStatus(keeper, 'quarantined')
    const r = await p
    assert.equal(store.get(sib)?.status, 'verified') // fold aborted -> sibling not archived
    assert.equal(r.merged, 0) // the aborted fold is not counted as a merge
  })

  test('cross-cluster: a fold is aborted when its keeper would be cascade-quarantined by another cluster', async () => {
    // cluster A (alpha) folds; B's keeper depends (by id) on an alpha sibling that gets archived,
    // so B's keeper will be cascade-quarantined -> B's siblings must NOT be archived (else B's use
    // case is left with a quarantined replacement = silent loss).
    await addVerified(store, { name: 'alpha', iface: '(a)->a', impl: 'return input', test: 'assert(run("a") === "a")', utility: 10 })
    const a5 = await addVerified(store, { name: 'alpha', iface: '(a)->a', impl: 'return input', test: 'assert(run("a") === "a")', utility: 5 })
    await addVerified(store, { name: 'alpha', iface: '(a)->a', impl: 'return input', test: 'assert(run("a") === "a")', utility: 0 })
    const bKeeper = await addVerified(store, { name: 'beta', iface: '(b)->b', impl: 'return input + "!"', test: 'assert(run("a") === "a!")', utility: 10 })
    const b5 = await addVerified(store, { name: 'beta', iface: '(b)->b', impl: 'return input + "!"', test: 'assert(run("a") === "a!")', utility: 5 })
    const b0 = await addVerified(store, { name: 'beta', iface: '(b)->b', impl: 'return input + "!"', test: 'assert(run("a") === "a!")', utility: 0 })
    store.addDep(bKeeper, a5) // B's keeper depends on an alpha sibling that will be archived
    await consolidate(store, embedder)
    assert.equal(store.get(bKeeper)?.status, 'quarantined') // keeper cascade-quarantined
    assert.equal(store.get(b5)?.status, 'verified') // B's fold aborted -> siblings preserved
    assert.equal(store.get(b0)?.status, 'verified')
  })

  test('cross-cluster: a keeper depending on ANOTHER cluster\'s folded skill IS cascade-quarantined', async () => {
    // two independent clusters (distinct interfaces -> never merged together)
    const a = await addVerified(store, { name: 'alpha', iface: '(a)->a', impl: 'return input + 1', test: 'assert(run(1) === 2)', utility: 10 })
    await addVerified(store, { name: 'alpha', iface: '(a)->a', impl: 'return input + 1', test: 'assert(run(1) === 2)', utility: 5 })
    await addVerified(store, { name: 'alpha', iface: '(a)->a', impl: 'return input + 1', test: 'assert(run(1) === 2)', utility: 0 })
    await addVerified(store, { name: 'beta', iface: '(b)->b', impl: 'return input + 2', test: 'assert(run(1) === 3)', utility: 10 })
    const b = await addVerified(store, { name: 'beta', iface: '(b)->b', impl: 'return input + 2', test: 'assert(run(1) === 3)', utility: 5 })
    await addVerified(store, { name: 'beta', iface: '(b)->b', impl: 'return input + 2', test: 'assert(run(1) === 3)', utility: 0 })
    store.addDep(a, b) // alpha keeper depends on a beta sibling that gets folded/archived
    await consolidate(store, embedder)
    assert.equal(store.get(b)?.status, 'archived')
    assert.equal(store.get(a)?.status, 'quarantined') // per-cluster protect does NOT shield it
  })
})
