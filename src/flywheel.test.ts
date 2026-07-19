import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNewSkillFires, ingestLedger } from './flywheel.ts'
import { SkillStore } from './store.ts'
import { Praxis } from './praxis.ts'
import { HashingEmbedder } from './embedder.ts'
import { syncSkills } from './export.ts'

const line = (skill: string, sid = 's1') =>
  JSON.stringify({ ts: '2026-07-19T00:00:00Z', kind: 'skill_fire', sid, skill }) + '\n'

describe('readNewSkillFires', () => {
  test('missing ledger: no-op', () => {
    const store = new SkillStore()
    const r = readNewSkillFires(store, join(tmpdir(), 'praxis-none', 'nope.jsonl'))
    assert.deepEqual(r, { fires: [], malformed: 0 })
    store.close()
  })

  test('reads only praxis-* skill_fire events, skips malformed, advances cursor incrementally', () => {
    const dir = mkdtempSync(join(tmpdir(), 'praxis-fw-'))
    const ledger = join(dir, 'ledger.jsonl')
    const store = new SkillStore()
    writeFileSync(ledger, line('praxis-double') + line('superpowers:tdd') + 'NOT JSON\n' + JSON.stringify({ kind: 'tool', name: 'Bash' }) + '\n')
    const r1 = readNewSkillFires(store, ledger)
    assert.deepEqual(r1.fires, [{ skill: 'praxis-double', sid: 's1' }])
    assert.equal(r1.malformed, 1)
    assert.equal(readNewSkillFires(store, ledger).fires.length, 0)
    appendFileSync(ledger, line('praxis-double', 's2'))
    const r3 = readNewSkillFires(store, ledger)
    assert.deepEqual(r3.fires, [{ skill: 'praxis-double', sid: 's2' }])
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('rotated/truncated ledger resets cursor to 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'praxis-fw-rot-'))
    const ledger = join(dir, 'ledger.jsonl')
    const store = new SkillStore()
    writeFileSync(ledger, line('praxis-a') + line('praxis-b', 's2'))
    readNewSkillFires(store, ledger)
    writeFileSync(ledger, line('praxis-c', 's3')) // rotation: smaller file
    const r = readNewSkillFires(store, ledger)
    assert.deepEqual(r.fires, [{ skill: 'praxis-c', sid: 's3' }])
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('partial trailing line (no newline) is not consumed until complete', () => {
    const dir = mkdtempSync(join(tmpdir(), 'praxis-fw-part-'))
    const ledger = join(dir, 'ledger.jsonl')
    const store = new SkillStore()
    writeFileSync(ledger, line('praxis-a') + '{"kind":"skill_fire","skill":"praxis-b"')
    assert.equal(readNewSkillFires(store, ledger).fires.length, 1)
    appendFileSync(ledger, ',"sid":"s9"}\n')
    const r = readNewSkillFires(store, ledger)
    assert.deepEqual(r.fires, [{ skill: 'praxis-b', sid: 's9' }])
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('ingestLedger', () => {
  test('fires feed retrieval/generality and raise utility; unknown names counted unmatched; no fabricated successes', async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), 'praxis-ing-skills-'))
    const dir = mkdtempSync(join(tmpdir(), 'praxis-ing-'))
    const ledger = join(dir, 'ledger.jsonl')
    const px = new Praxis(new SkillStore(), new HashingEmbedder())
    const r = (await px.remember({
      name: 'double',
      interface: '(n)->n',
      implementation: 'return input * 2',
      acceptanceTest: 'assert(run(2) === 4)',
      task: 'double a number',
    })) as { id: string }
    syncSkills(px, { dir: skillsDir })
    const before = px.store.get(r.id)!

    writeFileSync(ledger, line('praxis-double', 'sess-1') + line('praxis-double', 'sess-2') + line('praxis-ghost', 'sess-3'))
    const res = ingestLedger(px, skillsDir, ledger)
    assert.deepEqual({ fires: res.fires, matched: res.matched, unmatched: res.unmatched }, { fires: 3, matched: 2, unmatched: 1 })

    const after = px.store.get(r.id)!
    assert.equal(px.store.distinctRetrievalTasks(r.id), 2)
    assert.ok(after.utilityScore > before.utilityScore, `utility ${after.utilityScore} should exceed ${before.utilityScore}`)
    // no fabricated outcomes: uses/successRate untouched
    assert.equal(after.uses, before.uses)
    assert.equal(after.successRate, before.successRate)

    px.store.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(skillsDir, { recursive: true, force: true })
  })
})
