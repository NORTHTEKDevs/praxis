import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

test('node:sqlite round-trips', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)')
  db.prepare('INSERT INTO t(name) VALUES (?)').run('reverse')
  const row = db.prepare('SELECT name FROM t WHERE id = 1').get() as { name: string }
  assert.equal(row.name, 'reverse')
})

test('type stripping handles typed syntax', () => {
  const double = (x: number): number => x * 2
  const xs: number[] = [1, 2, 3]
  assert.equal(double(xs[2]), 6)
})
