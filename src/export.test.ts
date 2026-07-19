import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slugify, buildSkillMd, buildImplMjs, skillHash, syncSkills } from './export.ts'
import { SkillStore } from './store.ts'
import { Praxis } from './praxis.ts'
import { HashingEmbedder } from './embedder.ts'
import type { Skill } from './skill.ts'

const mkSkill = (over: Partial<Skill> = {}): Skill => ({
  id: 'abc-123',
  name: 'Fix CORS: vercel',
  interface: '(url:string)->boolean',
  implementation: 'return input.length > 0',
  acceptanceTest: 'assert(run("x") === true)',
  capabilities: [],
  cost: 'cheap',
  provenance: { task: 'check CORS: preflight on vercel', model: 'test', parents: [], createdAt: 1e12, evidence: '' },
  embedding: [],
  embedderVersion: 'hashing-v1',
  utilityScore: 1,
  status: 'verified',
  version: 3,
  kind: 'positive',
  tier: 'hot',
  uses: 2,
  successRate: 1,
  pinned: false,
  checkStrength: 2,
  ...over,
})

describe('export pure functions', () => {
  test('slugify: lowercase kebab, strips unsafe chars, praxis- prefix', () => {
    assert.equal(slugify('Fix CORS: vercel'), 'praxis-fix-cors-vercel')
    assert.equal(slugify('  weird__name!!  '), 'praxis-weird-name')
    assert.equal(slugify(''), 'praxis-skill')
  })

  test('buildSkillMd: frontmatter is colon-safe and carries praxis metadata', () => {
    const md = buildSkillMd(mkSkill())
    const fm = md.split('---')[1]
    assert.match(fm, /^name: praxis-fix-cors-vercel$/m)
    // description is double-quoted (colon-in-value YAML trap) and single-line
    assert.match(fm, /^description: "USE WHEN [^\n]*"$/m)
    assert.doesNotMatch(fm, /^description: [^"]/m)
    assert.match(fm, /praxis:\n {2}id: abc-123\n {2}status: verified\n {2}version: 3\n {2}hash: [0-9a-f]{12}$/m)
    assert.ok(md.includes('run_skill'))
    assert.ok(md.includes('assert(run("x") === true)'))
  })

  test('buildSkillMd stale variant: STALE prefix + quarantined status', () => {
    const md = buildSkillMd(mkSkill({ status: 'quarantined' }))
    assert.match(md, /description: "\[STALE - failed re-verify\] /)
    assert.match(md, /status: quarantined/)
  })

  test('buildImplMjs wraps the function body', () => {
    const mjs = buildImplMjs(mkSkill())
    assert.ok(mjs.includes('export default function run(input'))
    assert.ok(mjs.includes('return input.length > 0'))
  })

  test('skillHash: stable, changes when implementation changes', () => {
    const a = skillHash(mkSkill())
    assert.equal(a, skillHash(mkSkill()))
    assert.notEqual(a, skillHash(mkSkill({ implementation: 'return 1' })))
  })
})

describe('syncSkills', () => {
  const px = () => new Praxis(new SkillStore(), new HashingEmbedder())

  test('exports verified hot, idempotent, stales on quarantine, prunes deleted, never touches foreign files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'praxis-sync-'))
    const p = px()
    const r = (await p.remember({
      name: 'double',
      interface: '(n)->n',
      implementation: 'return input * 2',
      acceptanceTest: 'assert(run(2) === 4)',
      task: 'double a number',
    })) as { status: string; id?: string }
    assert.equal(r.status, 'verified')
    const id = r.id!

    mkdirSync(join(dir, 'my-own-skill'), { recursive: true })
    writeFileSync(join(dir, 'my-own-skill', 'SKILL.md'), 'mine')

    const s1 = syncSkills(p, { dir })
    assert.equal(s1.exported, 1)
    const skillDir = join(dir, 'praxis-double')
    assert.ok(readFileSync(join(skillDir, 'SKILL.md'), 'utf8').includes('praxis-double'))
    assert.ok(existsSync(join(skillDir, 'impl.mjs')))

    const s2 = syncSkills(p, { dir })
    assert.deepEqual(
      { exported: s2.exported, updated: s2.updated, staled: s2.staled, pruned: s2.pruned },
      { exported: 0, updated: 0, staled: 0, pruned: 0 },
    )

    p.store.updateStatus(id, 'quarantined')
    const s3 = syncSkills(p, { dir })
    assert.equal(s3.staled, 1)
    assert.match(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), /STALE - failed re-verify/)

    // stale is sticky: another sync does not re-stale
    const s3b = syncSkills(p, { dir })
    assert.equal(s3b.staled, 0)

    p.store.delete(id)
    const s4 = syncSkills(p, { dir, prune: true })
    assert.equal(s4.pruned, 1)
    assert.ok(!existsSync(skillDir))

    assert.equal(readFileSync(join(dir, 'my-own-skill', 'SKILL.md'), 'utf8'), 'mine')
    p.store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('demotion out of hot tier stales the export (only hot/pinned stay exported)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'praxis-sync-tier-'))
    const p = px()
    const r = (await p.remember({
      name: 'triple',
      interface: '(n)->n',
      implementation: 'return input * 3',
      acceptanceTest: 'assert(run(2) === 6)',
      task: 'triple a number',
    })) as { id?: string }
    syncSkills(p, { dir })
    const s = p.store.get(r.id!)!
    s.tier = 'warm'
    p.store.update(s)
    const res = syncSkills(p, { dir })
    assert.equal(res.staled, 1)
    assert.match(readFileSync(join(dir, 'praxis-triple', 'SKILL.md'), 'utf8'), /STALE/)
    p.store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('slug collision: second skill gets id-suffixed dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'praxis-sync-col-'))
    const p = px()
    await p.remember({ name: 'same name', interface: '(n)->n', implementation: 'return input + 1', acceptanceTest: 'assert(run(1) === 2)', task: 'inc' })
    await p.remember({ name: 'same:name', interface: '(n)->n', implementation: 'return input + 2', acceptanceTest: 'assert(run(1) === 3)', task: 'inc2' })
    const res = syncSkills(p, { dir })
    assert.equal(res.exported, 2)
    assert.ok(existsSync(join(dir, 'praxis-same-name')))
    // exactly one additional id-suffixed dir
    assert.equal(readdirSync(dir).filter((d) => d.startsWith('praxis-same-name-')).length, 1)
    p.store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('corrupt manifest: rebuilt from praxis-* dirs, no duplicate exports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'praxis-sync-man-'))
    const p = px()
    await p.remember({ name: 'quad', interface: '(n)->n', implementation: 'return input * 4', acceptanceTest: 'assert(run(2) === 8)', task: 'quadruple' })
    syncSkills(p, { dir })
    writeFileSync(join(dir, '.praxis-manifest.json'), '{{{ not json')
    const res = syncSkills(p, { dir })
    assert.deepEqual({ exported: res.exported, updated: res.updated }, { exported: 0, updated: 0 })
    p.store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
