import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Praxis, RateLimiter, Semaphore, RateLimitError } from './praxis.ts'

const valid = (name: string, impl: string, acceptanceTest: string) => ({
  name,
  interface: '(x)->y',
  implementation: impl,
  acceptanceTest,
  task: name,
})

describe('Praxis integration', () => {
  let px: Praxis
  beforeEach(() => {
    px = new Praxis()
  })

  test('remember a valid skill -> verified and recallable', async () => {
    const r = await px.remember(valid('double', 'return input * 2', 'assert(run(3) === 6)'))
    assert.equal(r.status, 'verified')
    const rec = await px.recall('double', { k: 5 })
    assert.ok(rec.selected.some((s) => s.id === r.id))
  })

  test('remember a skill with a failing acceptance test -> not verified', async () => {
    const r = await px.remember(valid('bad', 'return input * 2', 'assert(run(3) === 999)'))
    assert.notEqual(r.status, 'verified')
  })

  test('remember a weak-test skill -> quarantined', async () => {
    const r = await px.remember(valid('weak', 'return 1', 'assert(true)'))
    assert.equal(r.status, 'quarantined')
  })

  test('remember + run a composed skill', async () => {
    await px.remember(valid('double', 'return input * 2', 'assert(run(3) === 6)'))
    const r = await px.remember(valid('double-plus', 'return call("double", input) + 1', 'assert(run(3) === 7)'))
    assert.equal(r.status, 'verified')
    const out = await px.run(r.id, 3)
    assert.equal(out.output, 7)
  })

  test('recall returns positives and negatives separately', async () => {
    await px.remember(valid('json-parser', 'return input', 'assert(run(1) === 1)'))
    await px.recordFailure({ task: 'parse nested json', approach: 'regex', reason: 'fails on depth > 2' })
    const rec = await px.recall('parse nested json', { k: 5 })
    assert.ok(rec.negatives.length >= 1)
    assert.ok(rec.negatives.every((s) => s.kind === 'negative'))
  })

  test('stats returns the expected shape', async () => {
    await px.remember(valid('double', 'return input * 2', 'assert(run(3) === 6)'))
    const s = px.stats()
    assert.equal(typeof s.total, 'number')
    assert.equal(typeof s.verified, 'number')
    assert.ok(Array.isArray(s.topSkills))
    assert.ok('avgCheckStrength' in s)
    assert.ok('weakTests' in s)
  })

  test('remember is rate-limited', async () => {
    const p = new Praxis(undefined, undefined, { rememberPerMin: 2 })
    await p.remember(valid('a', 'return 1', 'assert(run(1) === 1)'))
    await p.remember(valid('b', 'return 2', 'assert(run(1) === 2)'))
    await assert.rejects(p.remember(valid('c', 'return 3', 'assert(run(1) === 3)')), RateLimitError)
  })
})

describe('RateLimiter', () => {
  test('blocks past the max in the window, recovers after', () => {
    const rl = new RateLimiter(3, 1000)
    assert.ok(rl.allow(0))
    assert.ok(rl.allow(0))
    assert.ok(rl.allow(0))
    assert.ok(!rl.allow(0))
    assert.ok(rl.allow(2000))
  })
})

describe('Semaphore', () => {
  test('caps concurrency at max', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let peak = 0
    const task = () =>
      sem.run(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
      })
    await Promise.all([task(), task(), task(), task(), task()])
    assert.ok(peak <= 2)
  })
})
