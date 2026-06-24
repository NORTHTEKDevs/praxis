import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { Skill, SkillStatus } from './skill.ts'

const COLS =
  'id,name,interface,implementation,acceptanceTest,capabilities,cost,provenance,embedding,utilityScore,status,version'

export class SkillStore {
  private db: DatabaseSync

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    this.db.exec(`
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
        utilityScore REAL NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL
      )
    `)
  }

  insert(skill: Skill): string {
    const id = skill.id || randomUUID()
    this.db
      .prepare(`INSERT INTO skills (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        skill.name,
        skill.interface,
        skill.implementation,
        skill.acceptanceTest,
        JSON.stringify(skill.capabilities),
        skill.cost,
        JSON.stringify(skill.provenance),
        JSON.stringify(skill.embedding),
        skill.utilityScore,
        skill.status,
        skill.version,
      )
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
    this.db
      .prepare(
        `UPDATE skills SET name=?,interface=?,implementation=?,acceptanceTest=?,capabilities=?,cost=?,provenance=?,embedding=?,utilityScore=?,status=?,version=? WHERE id=?`,
      )
      .run(
        skill.name,
        skill.interface,
        skill.implementation,
        skill.acceptanceTest,
        JSON.stringify(skill.capabilities),
        skill.cost,
        JSON.stringify(skill.provenance),
        JSON.stringify(skill.embedding),
        skill.utilityScore,
        skill.status,
        skill.version,
        skill.id,
      )
  }

  listByStatus(status: SkillStatus): Skill[] {
    const rows = this.db
      .prepare('SELECT * FROM skills WHERE status = ? ORDER BY name')
      .all(status)
    return rows.map((r) => this.rowToSkill(r))
  }

  all(): Skill[] {
    const rows = this.db.prepare('SELECT * FROM skills').all()
    return rows.map((r) => this.rowToSkill(r))
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
  }

  private rowToSkill(r: any): Skill {
    return {
      id: r.id,
      name: r.name,
      interface: r.interface,
      implementation: r.implementation,
      acceptanceTest: r.acceptanceTest,
      capabilities: JSON.parse(r.capabilities),
      cost: r.cost,
      provenance: JSON.parse(r.provenance),
      embedding: JSON.parse(r.embedding),
      utilityScore: r.utilityScore,
      status: r.status,
      version: r.version,
    }
  }
}
