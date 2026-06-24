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
})
