import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { Skill, SkillStatus, SkillTier } from './skill.ts'

const COLS =
  'id,name,interface,implementation,acceptanceTest,capabilities,cost,provenance,' +
  'embedding,embedderVersion,utilityScore,status,version,kind,tier,uses,successRate,pinned,checkStrength'

const SCHEMA_VERSION = 1

export class SkillStore {
  private db: DatabaseSync
  private updateStmt: ReturnType<DatabaseSync['prepare']> | undefined

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    // WAL + busy_timeout: concurrent MCP calls + consolidation must not corrupt the
    // store. (WAL is a no-op on :memory: but harmless.)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        interface TEXT NOT NULL,
        implementation TEXT NOT NULL,
        acceptanceTest TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        cost TEXT NOT NULL,
        provenance TEXT NOT NULL,
        embedding TEXT NOT NULL,
        embedderVersion TEXT NOT NULL DEFAULT 'hashing-v1',
        utilityScore REAL NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('quarantined','verified','refuted','archived')),
        version INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'positive' CHECK (kind IN ('positive','negative')),
        tier TEXT NOT NULL DEFAULT 'hot' CHECK (tier IN ('hot','warm','cold')),
        uses INTEGER NOT NULL DEFAULT 0,
        successRate REAL NOT NULL DEFAULT 1.0,
        pinned INTEGER NOT NULL DEFAULT 0,
        checkStrength INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS skill_deps (
        skill_id TEXT NOT NULL,
        dep_id TEXT NOT NULL,
        PRIMARY KEY (skill_id, dep_id)
      );
      CREATE TABLE IF NOT EXISTS skill_retrievals (
        skill_id TEXT NOT NULL,
        task TEXT NOT NULL,
        retrieved_at INTEGER NOT NULL,
        PRIMARY KEY (skill_id, task)
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- hot read paths: listByStatus / listVerifiedHot / listVerifiedNegatives (status,kind,tier),
      -- findVerifiedByName (name), and dependentsOf (dep_id -- not covered by the deps PK prefix).
      CREATE INDEX IF NOT EXISTS idx_skills_status_kind_tier ON skills(status, kind, tier);
      CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
      CREATE INDEX IF NOT EXISTS idx_skill_deps_dep ON skill_deps(dep_id);
    `)
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION)
  }

  insert(skill: Skill): string {
    const id = skill.id || randomUUID()
    this.db
      .prepare(`INSERT INTO skills (${COLS}) VALUES (${COLS.split(',').map(() => '?').join(',')})`)
      .run(...this.toRow(id, skill))
    return id
  }

  get(id: string): Skill | undefined {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id)
    return row ? this.rowToSkill(row) : undefined
  }

  updateStatus(id: string, status: SkillStatus): void {
    this.db.prepare('UPDATE skills SET status = ? WHERE id = ?').run(status, id)
  }

  update(skill: Skill): void {
    if (!this.updateStmt) {
      // the UPDATE SQL is structurally constant; prepare once and reuse (retier issues N of these).
      const sets = COLS.split(',')
        .filter((c) => c !== 'id')
        .map((c) => `${c}=?`)
        .join(',')
      this.updateStmt = this.db.prepare(`UPDATE skills SET ${sets} WHERE id=?`)
    }
    const row = this.toRow(skill.id, skill)
    // move id (first element) to the end for the WHERE clause
    this.updateStmt.run(...row.slice(1), skill.id)
  }

  // Run fn inside a SINGLE write transaction so a bulk mutation (e.g. retier's N row updates)
  // commits once instead of N auto-commit transactions each with its own WAL fsync.
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  listByStatus(status: SkillStatus): Skill[] {
    const rows = this.db
      .prepare('SELECT * FROM skills WHERE status = ? ORDER BY name')
      .all(status)
    return rows.map((r) => this.rowToSkill(r))
  }

  listByTier(tier: SkillTier): Skill[] {
    const rows = this.db.prepare('SELECT * FROM skills WHERE tier = ? ORDER BY name').all(tier)
    return rows.map((r) => this.rowToSkill(r))
  }

  // Filter in SQL so recall's compute cost is O(hot-set), not O(all-verified).
  listVerifiedHot(): Skill[] {
    const rows = this.db
      .prepare("SELECT * FROM skills WHERE status = 'verified' AND kind = 'positive' AND tier = 'hot'")
      .all()
    return rows.map((r) => this.rowToSkill(r))
  }

  // Bounded by default: negatives have no eviction path, so an unbounded scan would grow O(N)
  // forever. Cap to the most-recent `limit` rows (rowid ascends with insertion) so recall's
  // negative pass stays O(cap), not O(all-negatives-ever-recorded).
  listVerifiedNegatives(limit = 200): Skill[] {
    const rows = this.db
      .prepare("SELECT * FROM skills WHERE status = 'verified' AND kind = 'negative' ORDER BY rowid DESC LIMIT ?")
      .all(limit)
    return rows.map((r) => this.rowToSkill(r))
  }

  all(): Skill[] {
    const rows = this.db.prepare('SELECT * FROM skills').all()
    return rows.map((r) => this.rowToSkill(r))
  }

  findVerifiedByName(name: string): Skill | undefined {
    const rows = this.db
      .prepare("SELECT * FROM skills WHERE name = ? AND status = 'verified' AND kind = 'positive' ORDER BY utilityScore DESC LIMIT 1")
      .all(name)
    return rows.length ? this.rowToSkill(rows[0]) : undefined
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM skill_retrievals WHERE skill_id = ?').run(id)
    this.db.prepare('DELETE FROM skill_deps WHERE skill_id = ? OR dep_id = ?').run(id, id)
  }

  addDep(skillId: string, depId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO skill_deps (skill_id, dep_id) VALUES (?, ?)')
      .run(skillId, depId)
  }

  dependentsOf(depId: string): string[] {
    const rows = this.db.prepare('SELECT skill_id FROM skill_deps WHERE dep_id = ?').all(depId)
    return rows.map((r) => (r as { skill_id: string }).skill_id)
  }

  recordRetrieval(skillId: string, task: string, retrievedAt: number): void {
    // OR REPLACE keyed on (skill_id, task) bounds the table to distinct (skill, task)
    // pairs -- exactly what generality counts -- instead of one row per recall forever.
    this.db
      .prepare('INSERT OR REPLACE INTO skill_retrievals (skill_id, task, retrieved_at) VALUES (?, ?, ?)')
      .run(skillId, task, retrievedAt)
  }

  distinctRetrievalTasks(skillId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(DISTINCT task) AS n FROM skill_retrievals WHERE skill_id = ?')
      .get(skillId) as { n: number }
    return row.n
  }

  // One query for all skills (used by retier instead of N per-skill SELECTs).
  allDistinctRetrievalCounts(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT skill_id, COUNT(DISTINCT task) AS n FROM skill_retrievals GROUP BY skill_id')
      .all()
    const m = new Map<string, number>()
    for (const r of rows) m.set((r as { skill_id: string }).skill_id, (r as { n: number }).n)
    return m
  }

  kvGet(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  kvSet(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  close(): void {
    this.db.close()
  }

  private toRow(id: string, s: Skill): unknown[] {
    return [
      id,
      s.name,
      s.interface,
      s.implementation,
      s.acceptanceTest,
      JSON.stringify(s.capabilities),
      s.cost,
      JSON.stringify(s.provenance),
      JSON.stringify(s.embedding),
      s.embedderVersion,
      s.utilityScore,
      s.status,
      s.version,
      s.kind,
      s.tier,
      s.uses,
      s.successRate,
      s.pinned ? 1 : 0,
      s.checkStrength,
    ]
  }

  private rowToSkill(r: any): Skill {
    // Tolerate a corrupt JSON column (WAL crash, external edit, bit flip): degrade the SINGLE
    // row to safe sentinels instead of throwing, which would otherwise deny EVERY bulk read
    // (get/listByStatus/all/recall) for the whole library until the bad row is removed.
    const parse = <T>(s: string, fallback: T): T => {
      try {
        return JSON.parse(s) as T
      } catch {
        return fallback
      }
    }
    return {
      id: r.id,
      name: r.name,
      interface: r.interface,
      implementation: r.implementation,
      acceptanceTest: r.acceptanceTest,
      capabilities: parse<string[]>(r.capabilities, []),
      cost: r.cost,
      provenance: parse(r.provenance, { task: '', model: '', parents: [], createdAt: 0, evidence: '' }),
      embedding: parse<number[]>(r.embedding, []),
      embedderVersion: r.embedderVersion,
      utilityScore: r.utilityScore,
      status: r.status,
      version: r.version,
      kind: r.kind,
      tier: r.tier,
      uses: r.uses,
      successRate: r.successRate,
      pinned: r.pinned === 1,
      checkStrength: r.checkStrength,
    }
  }
}
