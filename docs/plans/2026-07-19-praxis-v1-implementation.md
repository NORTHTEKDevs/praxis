# Praxis v1.0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship praxis 1.0.0 to npm with managed SKILL.md export (proven skills become Claude Code skills, lifecycle stays honest) and a flywheel Work Ledger soft adapter feeding usage into utility scoring.

**Architecture:** Two new modules. `src/export.ts` compiles verified hot skills to `.claude/skills/praxis-<slug>/` dirs (SKILL.md + impl.mjs) tracked by a manifest; sync is idempotent and marks exported files stale when their skill is quarantined/evicted. `src/flywheel.ts` incrementally reads the flywheel ledger (byte-offset cursor in a new `kv` table), maps `praxis-*` skill_fire events to skill ids via the manifest, and records them as retrievals (generality signal) - fire events carry no outcome, so no success is fabricated. `praxis sync` = ingest ledger -> retier -> export.

**Tech Stack:** Node 24 built-ins only (node:sqlite, node:test, node:crypto, node:fs). No new dependencies.

**Design doc:** `docs/plans/2026-07-19-skill-export-flywheel-design.md` (approved). Deviation from design: ledger events have no ok/outcome field, so the fold is `recordRetrieval` (usage/generality), not `reinforce(success)` - more honest, same machinery.

**Conventions:** Tests run with `npm test` (`node --experimental-strip-types --experimental-sqlite --test src/*.test.ts`). Single test file: `node --experimental-strip-types --experimental-sqlite --test src/export.test.ts`. Commits: Northtek <info@northtek.io>, no co-author trailer (public repo). Push after each green commit.

---

### Task 1: kv table in SkillStore

**Files:** Modify `src/store.ts`, Test `src/store.test.ts`

**Step 1: failing test** (append to `src/store.test.ts`):

```ts
test('kv: get missing returns undefined, set/get round-trips, set overwrites', () => {
  const store = new SkillStore()
  assert.equal(store.kvGet('cursor'), undefined)
  store.kvSet('cursor', '123')
  assert.equal(store.kvGet('cursor'), '123')
  store.kvSet('cursor', '456')
  assert.equal(store.kvGet('cursor'), '456')
  store.close()
})
```

**Step 2:** Run `node --experimental-strip-types --experimental-sqlite --test src/store.test.ts` - expect FAIL (`kvGet is not a function`).

**Step 3: implement.** In the schema exec block add:

```sql
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Add methods to `SkillStore`:

```ts
kvGet(key: string): string | undefined {
  const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

kvSet(key: string, value: string): void {
  this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
```

**Step 4:** Re-run store tests - expect PASS. **Step 5:** Commit `feat: kv table in SkillStore (flywheel cursor storage)`.

---

### Task 2: export pure functions - slugify, SKILL.md generation, content hash

**Files:** Create `src/export.ts`, Create `src/export.test.ts`

**Step 1: failing tests** (`src/export.test.ts`):

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify, buildSkillMd, buildImplMjs, skillHash } from './export.ts'
import type { Skill } from './skill.ts'

const mkSkill = (over: Partial<Skill> = {}): Skill => ({
  id: 'abc-123', name: 'Fix CORS: vercel', interface: '(url:string)->boolean',
  implementation: 'return input.length > 0', acceptanceTest: 'assert(run("x") === true)',
  capabilities: [], cost: 'cheap',
  provenance: { task: 'check CORS: preflight on vercel', model: 'test', parents: [], createdAt: 1e12, evidence: '' },
  embedding: [], embedderVersion: 'hashing-v1', utilityScore: 1, status: 'verified', version: 3,
  kind: 'positive', tier: 'hot', uses: 2, successRate: 1, pinned: false, checkStrength: 2, ...over,
})

test('slugify: lowercase kebab, strips unsafe chars, praxis- prefix', () => {
  assert.equal(slugify('Fix CORS: vercel'), 'praxis-fix-cors-vercel')
  assert.equal(slugify('  weird__name!!  '), 'praxis-weird-name')
})

test('buildSkillMd: frontmatter is colon-safe and carries praxis metadata', () => {
  const md = buildSkillMd(mkSkill())
  const fm = md.split('---')[1]
  assert.match(fm, /^name: praxis-fix-cors-vercel$/m)
  // description is double-quoted (colon-in-value YAML trap) and single-line
  assert.match(fm, /^description: "USE WHEN [^\n]*"$/m)
  assert.doesNotMatch(fm, /description: [^"]/)
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
```

**Step 2:** Run export tests - expect FAIL (module not found).

**Step 3: implement** (`src/export.ts`, first half):

```ts
import { createHash } from 'node:crypto'
import type { Skill } from './skill.ts'

export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return `praxis-${s || 'skill'}`
}

export function skillHash(s: Skill): string {
  return createHash('sha256')
    .update(`${s.interface}\n${s.implementation}\n${s.acceptanceTest}\n${s.version}`)
    .digest('hex')
    .slice(0, 12)
}

// One line, double-quoted, quotes/newlines escaped: colon-space inside an unquoted YAML
// value silently truncates the description (known SKILL.md trap).
function yamlQuote(text: string): string {
  return `"${text.replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function buildImplMjs(s: Skill): string {
  return `// praxis skill ${s.id} v${s.version} - proven implementation (function body over \`input\`).
// Composed sub-skill calls (call("name", x)) need the praxis runtime: use the run_skill MCP tool.
export default function run(input, call = () => { throw new Error('sub-skills need praxis run_skill') }) {
${s.implementation}
}
`
}

export function buildSkillMd(s: Skill): string {
  const stale = s.status !== 'verified'
  const desc = `${stale ? '[STALE - failed re-verify] ' : ''}USE WHEN ${s.provenance.task || s.name}. Proven skill from praxis, verified by executed acceptance test.`
  return `---
name: ${slugify(s.name)}
description: ${yamlQuote(desc)}
praxis:
  id: ${s.id}
  status: ${s.status}
  version: ${s.version}
  hash: ${skillHash(s)}
---

# ${slugify(s.name)}

${s.provenance.task || s.name}

Interface: \`${s.interface}\`
${stale ? '\n**This skill FAILED re-verification. Do not trust it; re-derive and re-prove.**\n' : ''}
## Run it

Preferred: call the praxis MCP tool \`run_skill\` with \`{"id": "${s.id}", "input": ...}\` - sandboxed, composed sub-skills resolved. Standalone reference: [impl.mjs](impl.mjs).

## Proof

Passed in the praxis sandbox:

\`\`\`js
${s.acceptanceTest}
\`\`\`

If it fails for you: praxis MCP tool \`reinforce\` \`{"id":"${s.id}","outcome":"failure"}\` - praxis re-runs the test and quarantines a now-broken skill (next sync marks this file stale).
`
}
```

**Step 4:** Re-run - expect PASS. **Step 5:** Commit `feat(export): slugify + SKILL.md/impl.mjs generation + content hash`.

---

### Task 3: syncSkills - manifest, idempotence, stale/prune, foreign-file safety

**Files:** Modify `src/export.ts`, Modify `src/export.test.ts`

**Step 1: failing tests** (append; use `fs.mkdtempSync` + in-memory store; build a real Praxis via `new Praxis(new SkillStore(), new HashingEmbedder())` and `await px.remember({...})` to get verified skills - see `src/praxis.test.ts` for the remember shape):

```ts
test('syncSkills: exports verified hot skills, is idempotent, marks stale on quarantine, prunes evicted, never touches foreign files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'praxis-sync-'))
  const px = new Praxis(new SkillStore(), new HashingEmbedder())
  const r = await px.remember({ name: 'double', interface: '(n)->n', implementation: 'return input * 2', acceptanceTest: 'assert(run(2) === 4)', task: 'double a number' })
  assert.equal(r.status, 'verified')

  // foreign file praxis must never touch
  mkdirSync(join(dir, 'my-own-skill'), { recursive: true })
  writeFileSync(join(dir, 'my-own-skill', 'SKILL.md'), 'mine')

  const s1 = syncSkills(px, { dir })
  assert.equal(s1.exported, 1)
  const skillDir = join(dir, 'praxis-double')
  assert.ok(readFileSync(join(skillDir, 'SKILL.md'), 'utf8').includes('praxis-double'))
  assert.ok(existsSync(join(skillDir, 'impl.mjs')))

  // idempotent: second sync writes nothing
  const s2 = syncSkills(px, { dir })
  assert.deepEqual({ exported: s2.exported, updated: s2.updated, staled: s2.staled, pruned: s2.pruned }, { exported: 0, updated: 0, staled: 0, pruned: 0 })

  // quarantine -> stale mark
  px.store.updateStatus(r.id!, 'quarantined')
  const s3 = syncSkills(px, { dir })
  assert.equal(s3.staled, 1)
  assert.match(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), /STALE - failed re-verify/)

  // eviction (deleted from store) -> prune removes dir
  px.store.delete(r.id!)
  const s4 = syncSkills(px, { dir, prune: true })
  assert.equal(s4.pruned, 1)
  assert.ok(!existsSync(skillDir))

  // foreign file untouched throughout
  assert.equal(readFileSync(join(dir, 'my-own-skill', 'SKILL.md'), 'utf8'), 'mine')
  px.store.close()
  rmSync(dir, { recursive: true, force: true })
})
```

Also: a slug-collision test (two verified skills whose names slugify identically -> second dir gets `-<id6>` suffix) and a corrupt-manifest test (garbage `.praxis-manifest.json` -> sync rebuilds by scanning `praxis-*` dirs for the `praxis:` id line and does not duplicate dirs).

**Step 2:** Run - FAIL (`syncSkills` not exported).

**Step 3: implement** (append to `src/export.ts`):

```ts
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Praxis } from './praxis.ts'

interface ManifestEntry { dir: string; hash: string; status: string; exportedAt: number }
interface Manifest { version: 1; skills: Record<string, ManifestEntry> }

const MANIFEST = '.praxis-manifest.json'

function loadManifest(dir: string): Manifest {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
    if (m && m.version === 1 && m.skills && typeof m.skills === 'object') return m
  } catch { /* missing or corrupt: rebuild below */ }
  // Rebuild by scanning praxis-* dirs for our metadata block; foreign dirs are never claimed.
  const skills: Record<string, ManifestEntry> = {}
  if (existsSync(dir)) {
    for (const d of readdirSync(dir)) {
      if (!d.startsWith('praxis-')) continue
      try {
        const md = readFileSync(join(dir, d, 'SKILL.md'), 'utf8')
        const id = /^praxis:\n {2}id: (.+)$/m.exec(md)?.[1]
        const hash = /^ {2}hash: ([0-9a-f]{12})$/m.exec(md)?.[1]
        const status = /^ {2}status: (.+)$/m.exec(md)?.[1]
        if (id && hash) skills[id] = { dir: d, hash, status: status ?? 'verified', exportedAt: 0 }
      } catch { /* not ours or unreadable: skip */ }
    }
  }
  return { version: 1, skills }
}

export interface SyncResult { exported: number; updated: number; staled: number; pruned: number; failed: string[] }

export function syncSkills(px: Praxis, opts: { dir: string; prune?: boolean }): SyncResult {
  const res: SyncResult = { exported: 0, updated: 0, staled: 0, pruned: 0, failed: [] }
  mkdirSync(opts.dir, { recursive: true })
  const manifest = loadManifest(opts.dir)
  const eligible = px.store.listVerifiedHot() // pinned skills are always hot (retier invariant)
  const taken = new Set(Object.values(manifest.skills).map((e) => e.dir))

  const writeSkill = (s: import('./skill.ts').Skill, entryDir: string) => {
    const d = join(opts.dir, entryDir)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), buildSkillMd(s))
    writeFileSync(join(d, 'impl.mjs'), buildImplMjs(s))
  }

  for (const s of eligible) {
    const prev = manifest.skills[s.id]
    try {
      if (!prev) {
        let dirName = slugify(s.name)
        if (taken.has(dirName)) dirName = `${dirName}-${s.id.replace(/-/g, '').slice(0, 6)}`
        taken.add(dirName)
        writeSkill(s, dirName)
        manifest.skills[s.id] = { dir: dirName, hash: skillHash(s), status: s.status, exportedAt: Date.now() }
        res.exported++
      } else if (prev.hash !== skillHash(s) || prev.status !== s.status) {
        writeSkill(s, prev.dir)
        manifest.skills[s.id] = { ...prev, hash: skillHash(s), status: s.status, exportedAt: Date.now() }
        res.updated++
      }
    } catch (e) {
      res.failed.push(`${s.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Lifecycle: exported skills that are no longer verified+hot get staled (default) or pruned.
  const eligibleIds = new Set(eligible.map((s) => s.id))
  for (const [id, entry] of Object.entries(manifest.skills)) {
    if (eligibleIds.has(id)) continue
    const skill = px.store.get(id)
    try {
      if (opts.prune || !existsSync(join(opts.dir, entry.dir))) {
        rmSync(join(opts.dir, entry.dir), { recursive: true, force: true })
        delete manifest.skills[id]
        res.pruned++
      } else if (entry.status !== 'quarantined') {
        // demoted/evicted/quarantined -> rewrite as stale so the file cannot outlive its proof
        const stale = skill ?? { ...fallbackSkill(id, entry), status: 'quarantined' as const }
        writeSkill({ ...stale, status: skill?.status === 'verified' ? 'quarantined' : (stale.status as never) } as never, entry.dir)
        manifest.skills[id] = { ...entry, status: 'quarantined' }
        res.staled++
      }
    } catch (e) {
      res.failed.push(`${id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  writeFileSync(join(opts.dir, MANIFEST), JSON.stringify(manifest, null, 2))
  return res
}
```

(`fallbackSkill` builds a minimal Skill for a store-deleted id so the stale rewrite still works: name from `entry.dir`, empty impl/test, `status: 'quarantined'`. The exact shape is the implementer's call - the test pins observable behavior: staled file contains the STALE marker; deleted+prune removes the dir.)

Note the tier subtlety the test must pin: a skill demoted verified-hot -> verified-warm is still callable, but it leaves the export set - it gets staled too (design: only hot/pinned stay exported). Keep that in one test case.

**Step 4:** Run export tests - PASS. Run full `npm test` - PASS (no regressions). **Step 5:** Commit `feat(export): managed syncSkills with manifest, stale/prune lifecycle, foreign-file safety`.

---

### Task 4: wire sync_skills MCP tool + praxis sync CLI

**Files:** Modify `src/tools.ts`, `src/cli.ts`, Test `src/tools.test.ts`

**Step 1: failing test** (append to `src/tools.test.ts`, following its existing harness pattern):

```ts
test('sync_skills tool exports to dir and reports counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'praxis-tool-sync-'))
  // remember one verified skill on the test px, then:
  const tool = tools.find((t) => t.name === 'sync_skills')!
  const r = (await tool.handler({ dir })) as { exported: number }
  assert.equal(r.exported, 1)
  assert.ok(existsSync(join(dir, '.praxis-manifest.json')))
  rmSync(dir, { recursive: true, force: true })
})
```

**Step 2:** FAIL (tool missing). **Step 3:** Add to `buildTools`:

```ts
{
  name: 'sync_skills',
  description: 'Compile verified hot skills to Claude Code SKILL.md dirs (praxis-* namespace). Idempotent; marks stale skills whose proof no longer holds. Ingests the flywheel ledger first when present.',
  inputSchema: { type: 'object', properties: { dir: str('target skills dir (default ./.claude/skills)'), global: { type: 'boolean', description: 'target ~/.claude/skills instead' }, prune: { type: 'boolean', description: 'remove stale exports instead of marking them' } }, additionalProperties: false },
  handler: async (a) => {
    const dir = a.global ? join(homedir(), '.claude', 'skills') : (typeof a.dir === 'string' && a.dir ? a.dir : join(process.cwd(), '.claude', 'skills'))
    return fullSync(px, { dir, prune: a.prune === true })  // fullSync lands in Task 7; until then call syncSkills directly
  },
},
```

CLI (`src/cli.ts`): add `sync` branch parsing `--dir <path>`, `--global`, `--prune`, printing the JSON result; update the usage line. **Step 4:** tools tests + full suite PASS; CLI smoke: `PRAXIS_DIR=$(mktemp -d) npm run praxis -- sync --dir $(mktemp -d)` prints `{"exported":0,...}`. **Step 5:** Commit `feat: sync_skills MCP tool + praxis sync CLI`.

---

### Task 5: flywheel ledger reader with cursor

**Files:** Create `src/flywheel.ts`, Create `src/flywheel.test.ts`

**Step 1: failing tests:**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNewSkillFires } from './flywheel.ts'
import { SkillStore } from './store.ts'

const line = (skill: string, sid = 's1') => JSON.stringify({ ts: '2026-07-19T00:00:00Z', kind: 'skill_fire', sid, skill }) + '\n'

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
  assert.equal(r1.fires.length, 1)
  assert.deepEqual(r1.fires[0], { skill: 'praxis-double', sid: 's1' })
  assert.equal(r1.malformed, 1)
  // incremental: nothing new -> nothing read
  assert.equal(readNewSkillFires(store, ledger).fires.length, 0)
  // append -> only the new event
  appendFileSync(ledger, line('praxis-double', 's2'))
  const r3 = readNewSkillFires(store, ledger)
  assert.deepEqual(r3.fires, [{ skill: 'praxis-double', sid: 's2' }])
  store.close(); rmSync(dir, { recursive: true, force: true })
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
  store.close(); rmSync(dir, { recursive: true, force: true })
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
  store.close(); rmSync(dir, { recursive: true, force: true })
})
```

**Step 2:** FAIL. **Step 3: implement** (`src/flywheel.ts`):

```ts
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import type { SkillStore } from './store.ts'

const CURSOR_KEY = 'flywheel_cursor'

export interface SkillFire { skill: string; sid: string }

// Incremental read of the flywheel Work Ledger (append-only JSONL). Praxis reads the FILE
// FORMAT only - no dependency on the flywheel project. Absent file: no-op.
export function readNewSkillFires(store: SkillStore, ledgerPath: string): { fires: SkillFire[]; malformed: number } {
  let size: number
  try {
    size = statSync(ledgerPath).size
  } catch {
    return { fires: [], malformed: 0 }
  }
  let cursor = Number(store.kvGet(CURSOR_KEY) ?? 0)
  if (!Number.isFinite(cursor) || cursor < 0 || cursor > size) cursor = 0 // rotation/corruption
  if (cursor === size) return { fires: [], malformed: 0 }

  const fd = openSync(ledgerPath, 'r')
  let chunk: string
  try {
    const buf = Buffer.alloc(size - cursor)
    const n = readSync(fd, buf, 0, buf.length, cursor)
    chunk = buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
  const lastNl = chunk.lastIndexOf('\n')
  if (lastNl === -1) return { fires: [], malformed: 0 } // only a partial line so far
  const complete = chunk.slice(0, lastNl)
  store.kvSet(CURSOR_KEY, String(cursor + Buffer.byteLength(complete, 'utf8') + 1))

  const fires: SkillFire[] = []
  let malformed = 0
  for (const ln of complete.split('\n')) {
    if (!ln.trim()) continue
    try {
      const ev = JSON.parse(ln)
      if (ev?.kind === 'skill_fire' && typeof ev.skill === 'string' && ev.skill.startsWith('praxis-'))
        fires.push({ skill: ev.skill, sid: typeof ev.sid === 'string' ? ev.sid : 'unknown' })
    } catch {
      malformed++
    }
  }
  return { fires, malformed }
}
```

**Step 4:** PASS. **Step 5:** Commit `feat(flywheel): incremental ledger reader with cursor, rotation reset, partial-line safety`.

---

### Task 6: ingest - fires feed retrieval/generality, utility recomputes, retier

**Files:** Modify `src/flywheel.ts`, Modify `src/flywheel.test.ts`

**Step 1: failing test:** build a px with one verified skill, `syncSkills` to a tmp dir (creates the manifest mapping dir-name -> id), write a synthetic ledger with N `skill_fire` events for that dir name across distinct sids, call `ingestLedger(px, dir, ledgerPath)`, assert: `distinctRetrievalTasks(id)` grew, `utilityScore` strictly increased vs before, unknown `praxis-*` names are counted in `unmatched` not thrown.

**Step 2:** FAIL. **Step 3: implement** (append):

```ts
import { readFileSync as rf } from 'node:fs'
import { join as pjoin } from 'node:path'
import { utilityScore, retier } from './utility.ts'
import type { Praxis } from './praxis.ts'

// skill_fire events carry NO outcome - so a fire is recorded as a RETRIEVAL (usage/generality
// signal), never a fabricated success. successRate stays evidence-only via reinforce.
export function ingestLedger(px: Praxis, skillsDir: string, ledgerPath: string): { fires: number; matched: number; unmatched: number; malformed: number } {
  const { fires, malformed } = readNewSkillFires(px.store, ledgerPath)
  let matched = 0
  const dirToId = new Map<string, string>()
  try {
    const m = JSON.parse(rf(pjoin(skillsDir, '.praxis-manifest.json'), 'utf8'))
    for (const [id, e] of Object.entries(m.skills ?? {})) dirToId.set((e as { dir: string }).dir, id)
  } catch { /* no manifest yet: every fire is unmatched */ }
  const touched = new Set<string>()
  for (const f of fires) {
    const id = dirToId.get(f.skill)
    if (!id || !px.store.get(id)) continue
    px.store.recordRetrieval(id, `flywheel:${f.sid}`, Date.now())
    touched.add(id)
    matched++
  }
  for (const id of touched) {
    const s = px.store.get(id)
    if (!s) continue
    s.utilityScore = utilityScore(s, px.store.distinctRetrievalTasks(id))
    px.store.update(s)
  }
  if (touched.size) retier(px.store, px.hotCap)
  return { fires: fires.length, matched, unmatched: fires.length - matched, malformed }
}
```

**Step 4:** PASS + full suite. **Step 5:** Commit `feat(flywheel): ingest fires as retrievals -> utility recompute -> retier (no fabricated outcomes)`.

---

### Task 7: fullSync = ingest -> export; wire into tool + CLI

**Files:** Modify `src/export.ts` (or new `src/sync.ts`), `src/tools.ts`, `src/cli.ts`, tests

**Step 1: failing test:** `fullSync(px, { dir })` with a ledger present returns `{ ingest, sync }`; with `FLYWHEEL_LEDGER` unset and default path absent it still exports (ingest no-op). Ledger path resolution: `process.env.FLYWHEEL_LEDGER ?? join(homedir(), '.claude', 'state', 'ledger.jsonl')` - overridable via opts for tests.

**Step 2-3:**

```ts
export function fullSync(px: Praxis, opts: { dir: string; prune?: boolean; ledgerPath?: string }) {
  const ledger = opts.ledgerPath ?? process.env.FLYWHEEL_LEDGER ?? join(homedir(), '.claude', 'state', 'ledger.jsonl')
  const ingest = ingestLedger(px, opts.dir, ledger)   // usage first, so demotions/promotions reflect
  const sync = syncSkills(px, opts)                    // then files match the post-ingest truth
  return { ingest, sync }
}
```

Point the Task 4 tool handler and CLI `sync` at `fullSync`. **Step 4:** full `npm test` PASS. **Step 5:** Commit `feat: praxis sync = ledger ingest + retier + skill export`.

---

### Task 8: ship prep - 1.0.0, README, pack-install verification, publish handoff

**Files:** Modify `package.json`, `README.md`

**Steps:**
1. `package.json`: version `1.0.0`. Add `"docs"` exclusion is automatic (files whitelist already exists and does NOT include docs - verify `npm pack --dry-run` lists only src/bench/praxis.mjs/README/LICENSE/mcp-example; add `LICENSE` if npm doesn't auto-include it, and confirm `src/*.test.ts` inclusion is acceptable or tighten the whitelist to exclude tests).
2. README: new section "From proven skill to Claude Code skill" documenting `praxis sync`, the praxis-* namespace, stale semantics ("no exported skill outlives its proof"), and the flywheel loop (optional, reads the ledger file format, no dependency). Update the tools list to include `sync_skills`.
3. Real-tarball verification (the actual 404 fix - README's install line must be true):
   ```bash
   npm pack
   npm i -g ./northtek-praxis-1.0.0.tgz
   praxis init          # expect: self-test OK + stanza
   praxis sync --dir "$(mktemp -d)"   # expect: JSON result
   npm rm -g @northtek/praxis
   ```
   Capture output; all three must succeed.
4. SKILL.md load verification: sync a real skill into a scratch project dir, start `claude` in it (or list session skills), confirm the praxis-* skill appears. This is success criterion 2 - do not skip.
5. Commit `chore: v1.0.0 - README skill-export docs + pack verification`. Push.
6. HANDOFF (non-delegable): Kristian runs `npm publish --ignore-scripts` (passkey). Then verify `npm view @northtek/praxis version` returns `1.0.0`.

---

### Task 9: final gate

- Full suite green (captured output), CI green on push.
- `git log --oneline` shows one commit per task, Northtek identity, no co-author trailers.
- Success criteria from the design doc checked off 1-by-1 with evidence.
