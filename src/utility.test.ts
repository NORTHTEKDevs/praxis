import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SkillStore } from './store.ts'
import { runSkill } from './run.ts'
import { captureSkill } from './capture.ts'
import { utilityScore, reinforce, retier } from './utility.ts'

interface AddOpts {
  name: string
  impl?: string
  test?: string
  uses?: number
  successRate?: number
  pinned?: boolean
}

describe('utility scoring + tiering', () => {
  let store: SkillStore
  beforeEach(() => {
    store = new SkillStore(':memory:')
  })

  const addVerified = (o: AddOpts): string => {
    const s = captureSkill({
      name: o.name,
      interface: '(x)->y',
      implementation: o.impl ?? 'return input',
      acceptanceTest: o.test ?? 'assert(run(1) === 1)',
      task: o.name,
    })
    s.status = 'verified'
    if (o.uses !== undefined) s.uses = o.uses
    if (o.successRate !== undefined) s.successRate = o.successRate
    if (o.pinned) s.pinned = true
    return store.insert(s)
  }

  test('explicit weights: uses=0, successRate=1, createdAt=now, generality=0 -> 0.55', () => {
    const now = 1_000_000
    const s = captureSkill({ name: 'x', interface: '', implementation: 'return 1', acceptanceTest: 'assert(run(1) === 1)', task: 't', createdAt: now })
    const score = utilityScore(s, 0, now)
    assert.ok(Math.abs(score - 0.55) < 1e-9, `score=${score}`)
  })

  test('hot-set never exceeds the cap', () => {
    for (let i = 0; i < 15; i++) addVerified({ name: `s${i}`, uses: i })
    retier(store, 5)
    assert.equal(store.listByTier('hot').length, 5)
  })

  test('pinned low-utility skill stays hot when the hot-set is full', () => {
    addVerified({ name: 'h1', uses: 100 })
    addVerified({ name: 'h2', uses: 100 })
    const pin = addVerified({ name: 'pinned', uses: 0, pinned: true })
    const cold = addVerified({ name: 'lowprio', uses: 0 })
    retier(store, 2)
    assert.equal(store.get(pin)?.tier, 'hot')
    assert.notEqual(store.get(cold)?.tier, 'hot')
  })

  test('reinforce success raises score; failure lowers successRate', async () => {
    const id = addVerified({ name: 'd', impl: 'return input * 2', test: 'assert(run(3) === 6)', uses: 0, successRate: 1 })
    const before = store.get(id)!.utilityScore
    await reinforce(store, id, 'success')
    assert.ok(store.get(id)!.utilityScore > before)
    await reinforce(store, id, 'failure')
    assert.ok(store.get(id)!.successRate < 1)
    assert.equal(store.get(id)!.status, 'verified')
  })

  test('anti-regression: a failure-reinforce re-runs the acceptance test; broken skill quarantined', async () => {
    const id = addVerified({ name: 'broken', impl: 'return 1', test: 'assert(run(1) === 2)' })
    await reinforce(store, id, 'failure')
    assert.equal(store.get(id)!.status, 'quarantined')
  })

  test('cold-tier skill is still callable (tier is a hint, not a barrier)', async () => {
    const id = addVerified({ name: 'double', impl: 'return input * 2' })
    const s = store.get(id)!
    s.tier = 'cold'
    store.update(s)
    const r = await runSkill(store, id, 4)
    assert.equal(r.output, 8)
  })

  test('generality (distinct retrieval tasks) raises the utility score', () => {
    const id = addVerified({ name: 'g', uses: 0 })
    const base = utilityScore(store.get(id)!, 0)
    store.recordRetrieval(id, 'taskA', 1)
    store.recordRetrieval(id, 'taskB', 2)
    const withGen = utilityScore(store.get(id)!, store.distinctRetrievalTasks(id))
    assert.ok(withGen > base)
  })

  test('generality lifts a skill into the hot tier via retier (batched count is wired)', () => {
    const a = addVerified({ name: 'a' })
    addVerified({ name: 'b' })
    addVerified({ name: 'c' })
    for (const t of ['t1', 't2', 't3', 't4', 't5']) store.recordRetrieval(a, t, 1)
    retier(store, 1)
    assert.equal(store.get(a)?.tier, 'hot')
  })
})
