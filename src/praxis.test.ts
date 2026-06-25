import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Praxis, RateLimiter, Semaphore, RateLimitError } from './praxis.ts'
import { captureSkill } from './capture.ts'

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

  test('concurrent run() calls all settle under the shared verify semaphore', async () => {
    const p = new Praxis(undefined, undefined, { maxConcurrentVerify: 2 })
    const r = await p.remember(valid('dbl', 'return input * 2', 'assert(run(3) === 6)'))
    const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => p.run(r.id, i)))
    assert.equal(outs.length, 8)
    assert.deepEqual(
      outs.map((o) => o.output),
      [0, 2, 4, 6, 8, 10, 12, 14],
    )
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

  test('a remembered skill gets a real createdAt (recency is live, not 0)', async () => {
    const r = await px.remember(valid('ts', 'return input', 'assert(run(1) === 1)'))
    assert.ok(px.store.get(r.id)!.provenance.createdAt > 0)
  })

  test('reinforce failure cascades quarantine through dependents (end-to-end)', async () => {
    const sub = captureSkill({ name: 'sub', interface: '(x)->y', implementation: 'return 1', acceptanceTest: 'assert(run(1) === 2)', task: 'sub' })
    sub.status = 'verified'
    const subId = px.store.insert(sub)
    const comp = captureSkill({ name: 'comp', interface: '(x)->y', implementation: 'return call("sub", input)', acceptanceTest: 'assert(run(1) === 1)', task: 'comp' })
    comp.status = 'verified'
    const compId = px.store.insert(comp)
    px.store.addDep(compId, subId)
    await px.reinforce(subId, 'failure') // anti-regression re-runs sub's failing test -> quarantine -> cascade
    assert.equal(px.store.get(subId)?.status, 'quarantined')
    assert.equal(px.store.get(compId)?.status, 'quarantined')
  })

  test('reinforce on a nonexistent id throws (no silent success)', async () => {
    await assert.rejects(px.reinforce('does-not-exist', 'success'), /no skill/)
  })

  test('reinforce(failure) on a CORRECT composed skill does not quarantine it', async () => {
    await px.remember(valid('dep', 'return input * 2', 'assert(run(3) === 6)'))
    const comp = await px.remember(valid('usedep', 'return call("dep", input) + 1', 'assert(run(3) === 7)'))
    assert.equal(comp.status, 'verified')
    // the anti-regression re-run must resolve "dep" -> the correct composed skill stays verified
    const r = await px.reinforce(comp.id, 'failure')
    assert.equal(r?.status, 'verified')
  })

  test('pin rejects a non-verified skill', async () => {
    const s = captureSkill({ name: 'q', interface: '', implementation: 'return 1', acceptanceTest: 'assert(run(1) === 1)', task: 'q' })
    s.status = 'quarantined'
    const id = px.store.insert(s)
    assert.throws(() => px.pin(id), /only verified/)
  })

  test('recordFailure shares the rate limiter (also throttled)', async () => {
    const p = new Praxis(undefined, undefined, { rememberPerMin: 1 })
    await p.recordFailure({ task: 'x', approach: 'y', reason: 'z' })
    await assert.rejects(p.recordFailure({ task: 'x2', approach: 'y2', reason: 'z2' }), RateLimitError)
  })

  test('remember ignores an injected kind:negative (coerced to positive)', async () => {
    const r = await px.remember({ ...valid('inj', 'return 1', 'assert(run(1) === 1)'), kind: 'negative' } as never)
    assert.equal(px.store.get(r.id)?.kind, 'positive')
  })

  test('reinforce rejects a negative record', async () => {
    const id = await px.recordFailure({ task: 'parse json', approach: 'regex', reason: 'fails' })
    await assert.rejects(px.reinforce(id, 'success'), /negative record/)
  })

  test('reinforce rejects a non-verified (archived) skill', async () => {
    const r = await px.remember(valid('arch', 'return input', 'assert(run(1) === 1)'))
    px.store.updateStatus(r.id, 'archived')
    await assert.rejects(px.reinforce(r.id, 'success'), /not verified/)
  })

  test('reinforce rejects an invalid outcome', async () => {
    const r = await px.remember(valid('out', 'return input', 'assert(run(1) === 1)'))
    await assert.rejects(px.reinforce(r.id, 'bogus' as never), /outcome must be/)
  })

  test('reinforce(success) is rate-limited too (not just failure)', async () => {
    const p = new Praxis(undefined, undefined, { rememberPerMin: 2 })
    const r = await p.remember(valid('rl', 'return input * 2', 'assert(run(3) === 6)')) // token 1
    await p.reinforce(r.id, 'success') // token 2
    await assert.rejects(p.reinforce(r.id, 'success'), RateLimitError) // token 3 -> throttled
  })

  test('concurrent remember of identical skills does not duplicate (write-lock)', async () => {
    await Promise.all([
      px.remember(valid('dup', 'return input * 2', 'assert(run(3) === 6)')),
      px.remember(valid('dup', 'return input * 2', 'assert(run(3) === 6)')),
    ])
    const dups = px.store.listByStatus('verified').filter((s) => s.kind === 'positive' && s.name === 'dup')
    assert.equal(dups.length, 1)
  })

  test('repeated remember of an identical broken skill does not accumulate rows', async () => {
    await px.remember(valid('broken', 'return 0', 'assert(run(3) === 6)')) // verify fails
    await px.remember(valid('broken', 'return 0', 'assert(run(3) === 6)'))
    const broken = px.store.all().filter((s) => s.name === 'broken')
    assert.equal(broken.length, 1)
  })

  test('TOCTOU: a sub-skill demoted while a composite is mid-verify quarantines the composite at commit', async () => {
    await px.remember(valid('leaf', 'return input * 2', 'assert(run(3) === 6)'))
    const leaf = px.store.listByStatus('verified').find((s) => s.name === 'leaf')!
    // start remember; it resolves composition (leaf verified) synchronously, then parks on the
    // verify worker. Demote leaf during that await -> commit-time re-check must quarantine wrap.
    const p = px.remember(valid('wrap', 'return call("leaf", input) + 1', 'assert(run(3) === 7)'))
    px.store.updateStatus(leaf.id, 'quarantined')
    const r = await p
    assert.notEqual(r.status, 'verified')
  })

  test('concurrent reinforce(failure) calls all settle under the shared verify semaphore', async () => {
    const p = new Praxis(undefined, undefined, { maxConcurrentVerify: 2 })
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      ids.push((await p.remember(valid(`s${i}`, 'return input * 2', 'assert(run(3) === 6)'))).id)
    }
    // each reinforce('failure') re-runs verifySkill (anti-regression) through the semaphore;
    // they must all complete (no unbounded worker spawn, no crash).
    const results = await Promise.all(ids.map((id) => p.reinforce(id, 'failure')))
    assert.equal(results.length, 6)
    assert.ok(results.every((r) => r?.status === 'verified')) // tests still pass -> stay verified
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
