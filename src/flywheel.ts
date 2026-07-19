import { statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { utilityScore, retier } from './utility.ts'
import type { SkillStore } from './store.ts'
import type { Praxis } from './praxis.ts'

const CURSOR_KEY = 'flywheel_cursor'

export interface SkillFire {
  skill: string
  sid: string
}

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
  if (lastNl === -1) return { fires: [], malformed: 0 } // only a partial trailing line so far
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

export interface IngestResult {
  fires: number
  matched: number
  unmatched: number
  malformed: number
}

// skill_fire events carry NO outcome - so a fire is recorded as a RETRIEVAL (usage/generality
// signal), never a fabricated success. uses/successRate stay evidence-only via reinforce.
export function ingestLedger(px: Praxis, skillsDir: string, ledgerPath: string): IngestResult {
  const { fires, malformed } = readNewSkillFires(px.store, ledgerPath)
  const dirToId = new Map<string, string>()
  try {
    const m = JSON.parse(readFileSync(join(skillsDir, '.praxis-manifest.json'), 'utf8'))
    for (const [id, e] of Object.entries(m.skills ?? {})) dirToId.set((e as { dir: string }).dir, id)
  } catch {
    /* no manifest yet: every fire is unmatched */
  }
  let matched = 0
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
