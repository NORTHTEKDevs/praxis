import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Praxis } from './praxis.ts'
import { buildTools, wrapTool } from './tools.ts'

const byName = (px: Praxis, name: string) => buildTools(px).find((t) => t.name === name)!

describe('MCP tools', () => {
  test('wrapTool returns a success envelope', async () => {
    const r = await wrapTool(async () => ({ a: 1 }))
    assert.equal(r.isError, undefined)
    assert.match(r.content[0].text, /"a":1/)
  })

  test('wrapTool returns an error envelope on throw (no uncaught exception)', async () => {
    const r = await wrapTool(async () => {
      throw new Error('boom')
    })
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, /boom/)
  })

  test('remember_skill of a failing-acceptance skill is never verified', async () => {
    const px = new Praxis()
    const r = await byName(px, 'remember_skill').handler({ name: 'bad', interface: '(x)->y', implementation: 'return 1', acceptanceTest: 'assert(run(1) === 2)', task: 'bad' })
    assert.notEqual((r as { status: string }).status, 'verified')
  })

  test('remember_skill with a weak test returns quarantined', async () => {
    const px = new Praxis()
    const r = await byName(px, 'remember_skill').handler({ name: 'weak', interface: '(x)->y', implementation: 'return 1', acceptanceTest: 'assert(true)', task: 'weak' })
    assert.equal((r as { status: string }).status, 'quarantined')
  })

  test('library_stats returns the expected shape', async () => {
    const px = new Praxis()
    const r = (await byName(px, 'library_stats').handler({})) as Record<string, unknown>
    assert.ok('total' in r)
    assert.ok('verified' in r)
    assert.ok('topSkills' in r)
  })

  test('all 8 tools are exposed', () => {
    assert.equal(buildTools(new Praxis()).length, 8)
  })

  test('reinforce on a nonexistent id surfaces an MCP error envelope, not a silent success', async () => {
    const px = new Praxis()
    const r = await wrapTool(() => byName(px, 'reinforce').handler({ id: 'nope', outcome: 'success' }))
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, /no skill/)
  })

  test('run_skill handler executes a verified skill end-to-end', async () => {
    const px = new Praxis()
    const rem = (await byName(px, 'remember_skill').handler({ name: 'double', interface: '(n)->n', implementation: 'return input * 2', acceptanceTest: 'assert(run(3) === 6)', task: 'double' })) as { id: string }
    const out = (await byName(px, 'run_skill').handler({ id: rem.id, input: 5 })) as { output: unknown }
    assert.equal(out.output, 10)
  })

  test('pin_skill handler flips the pinned flag', async () => {
    const px = new Praxis()
    const rem = (await byName(px, 'remember_skill').handler({ name: 'double', interface: '(n)->n', implementation: 'return input * 2', acceptanceTest: 'assert(run(3) === 6)', task: 'double' })) as { id: string }
    await byName(px, 'pin_skill').handler({ id: rem.id })
    assert.equal(px.store.get(rem.id)?.pinned, true)
  })

  test('consolidate_now handler runs and returns counts', async () => {
    const px = new Praxis()
    const r = (await byName(px, 'consolidate_now').handler({ dryRun: true })) as Record<string, unknown>
    assert.ok('merged' in r)
    assert.ok('evicted' in r)
  })

  test('recall_skills clamps a non-finite k instead of returning empty', async () => {
    const px = new Praxis()
    await byName(px, 'remember_skill').handler({ name: 'd', interface: '(n)->n', implementation: 'return input * 2', acceptanceTest: 'assert(run(3) === 6)', task: 'double a number' })
    const r = (await byName(px, 'recall_skills').handler({ query: 'double a number', k: Number.NaN })) as { skills: unknown[] }
    assert.ok(r.skills.length >= 1)
  })

  test('run_skill rejects an oversized input via the size guard', async () => {
    const px = new Praxis()
    const r = await wrapTool(() => byName(px, 'run_skill').handler({ id: 'x', input: 'a'.repeat(100_001) }))
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, /too large/)
  })

  test('record_failure handler stores a negative surfaced on recall', async () => {
    const px = new Praxis()
    await byName(px, 'record_failure').handler({ task: 'parse nested json', approach: 'regex', reason: 'fails past depth 2' })
    const r = (await byName(px, 'recall_skills').handler({ query: 'parse nested json' })) as { negatives: unknown[] }
    assert.ok(r.negatives.length >= 1)
  })

  test('wrapTool stringifies a non-Error throw into the envelope', async () => {
    const r = await wrapTool(async () => {
      throw 'plain string failure'
    })
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, /plain string failure/)
  })

  test('pin_skill handler can unpin (pinned:false)', async () => {
    const px = new Praxis()
    const rem = (await byName(px, 'remember_skill').handler({ name: 'double', interface: '(n)->n', implementation: 'return input * 2', acceptanceTest: 'assert(run(3) === 6)', task: 'double' })) as { id: string }
    await byName(px, 'pin_skill').handler({ id: rem.id })
    await byName(px, 'pin_skill').handler({ id: rem.id, pinned: false })
    assert.equal(px.store.get(rem.id)?.pinned, false)
  })

  test('recall_skills clamps a negative tokenBudget', async () => {
    const px = new Praxis()
    await byName(px, 'remember_skill').handler({ name: 'd', interface: '(n)->n', implementation: 'return input * 2', acceptanceTest: 'assert(run(3) === 6)', task: 'double a number' })
    const r = (await byName(px, 'recall_skills').handler({ query: 'double a number', tokenBudget: -1 })) as { skills: unknown[] }
    assert.ok(r.skills.length >= 1)
  })
})
