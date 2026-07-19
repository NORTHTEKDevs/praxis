import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Skill } from './skill.ts'
import type { Praxis } from './praxis.ts'

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

interface ManifestEntry {
  dir: string
  hash: string
  status: string
  exportedAt: number
}
interface Manifest {
  version: 1
  skills: Record<string, ManifestEntry>
}

const MANIFEST = '.praxis-manifest.json'

function loadManifest(dir: string): Manifest {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
    if (m && m.version === 1 && m.skills && typeof m.skills === 'object') return m
  } catch {
    /* missing or corrupt: rebuild below */
  }
  // Rebuild by scanning praxis-* dirs for our metadata block; foreign dirs are never claimed.
  const skills: Record<string, ManifestEntry> = {}
  if (existsSync(dir)) {
    for (const d of readdirSync(dir)) {
      if (!d.startsWith('praxis-')) continue
      try {
        const md = readFileSync(join(dir, d, 'SKILL.md'), 'utf8')
        const id = /^ {2}id: (.+)$/m.exec(md)?.[1]
        const hash = /^ {2}hash: ([0-9a-f]{12})$/m.exec(md)?.[1]
        const status = /^ {2}status: (.+)$/m.exec(md)?.[1]
        if (id && hash) skills[id] = { dir: d, hash, status: status ?? 'verified', exportedAt: 0 }
      } catch {
        /* not ours or unreadable: skip */
      }
    }
  }
  return { version: 1, skills }
}

// Minimal stand-in for a store-deleted skill so its export can still be rewritten as stale.
function tombstoneSkill(id: string, entry: ManifestEntry): Skill {
  return {
    id,
    name: entry.dir.replace(/^praxis-/, ''),
    interface: '(unknown)',
    implementation: '// original implementation no longer in the praxis store',
    acceptanceTest: '// no longer available',
    capabilities: [],
    cost: 'normal',
    provenance: { task: '', model: '', parents: [], createdAt: 0, evidence: '' },
    embedding: [],
    embedderVersion: '',
    utilityScore: 0,
    status: 'quarantined',
    version: 0,
    kind: 'positive',
    tier: 'cold',
    uses: 0,
    successRate: 0,
    pinned: false,
    checkStrength: 0,
  }
}

export interface SyncResult {
  exported: number
  updated: number
  staled: number
  pruned: number
  failed: string[]
}

// Idempotent compile of verified hot skills into <dir>/praxis-<slug>/ (SKILL.md + impl.mjs),
// tracked by a manifest. Lifecycle invariant: no exported skill outlives its proof - a skill
// that leaves the verified hot set gets its export marked stale (default) or pruned.
// Files praxis did not write are never touched.
export function syncSkills(px: Praxis, opts: { dir: string; prune?: boolean }): SyncResult {
  const res: SyncResult = { exported: 0, updated: 0, staled: 0, pruned: 0, failed: [] }
  mkdirSync(opts.dir, { recursive: true })
  const manifest = loadManifest(opts.dir)
  const eligible = px.store.listVerifiedHot() // pinned skills are always hot (retier invariant)
  const taken = new Set(Object.values(manifest.skills).map((e) => e.dir))

  const writeSkill = (s: Skill, entryDir: string) => {
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

  const eligibleIds = new Set(eligible.map((s) => s.id))
  for (const [id, entry] of Object.entries(manifest.skills)) {
    if (eligibleIds.has(id)) continue
    try {
      if (opts.prune) {
        rmSync(join(opts.dir, entry.dir), { recursive: true, force: true })
        delete manifest.skills[id]
        res.pruned++
      } else if (entry.status !== 'quarantined') {
        const s = px.store.get(id) ?? tombstoneSkill(id, entry)
        // whatever the reason for leaving the export set (quarantined, demoted, deleted),
        // the exported file must stop claiming a live proof
        writeSkill({ ...s, status: 'quarantined' }, entry.dir)
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
