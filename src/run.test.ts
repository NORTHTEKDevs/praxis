import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SkillStore } from './store.ts'
import { runSkill } from './run.ts'
import { CompositionError, quarantineCascade } from './composition.ts'
import { captureSkill } from './capture.ts'

interface AddOpts {
  name: string
  impl: string
  caps?: string[]
  deps?: string[]
}

describe('runSkill + composition', () => {
  let store: SkillStore
  beforeEach(() => {
    store = new SkillStore(':memory:')
  })

  const addVerified = (o: AddOpts): string => {
    const s = captureSkill({
      name: o.name,
      interface: '(x)->y',
      implementation: o.impl,
      acceptanceTest: 'assert(run(1) === 1)',
      task: o.name,
      capabilities: o.caps ?? [],
    })
    s.status = 'verified'
    const id = store.insert(s)
    for (const d of o.deps ?? []) store.addDep(id, d)
    return id
  }

  test('leaf skill runs and returns output', async () => {
    const id = addVerified({ name: 'double', impl: 'return input * 2' })
    const r = await runSkill(store, id, 3)
    assert.equal(r.output, 6)
  })

  test('composed skill calls a verified sub-skill', async () => {
    addVerified({ name: 'double', impl: 'return input * 2' })
    const id = addVerified({ name: 'double-plus', impl: 'return call("double", input) + 1' })
    const r = await runSkill(store, id, 3)
    assert.equal(r.output, 7)
  })

  test('referencing a non-verified sub-skill is a CompositionError (not a timeout)', async () => {
    const id = addVerified({ name: 'caller', impl: 'return call("ghost", input)' })
    await assert.rejects(runSkill(store, id, 1), CompositionError)
  })

  test('cyclic composition is detected at validation time', async () => {
    const a = addVerified({ name: 'A', impl: 'return call("B", input)' })
    addVerified({ name: 'B', impl: 'return call("A", input)' })
    await assert.rejects(runSkill(store, a, 1), CompositionError)
  })

  test('composition deeper than maxDepth is rejected', async () => {
    addVerified({ name: 'c', impl: 'return 1' })
    addVerified({ name: 'b', impl: 'return call("c", input)' })
    const a = addVerified({ name: 'a', impl: 'return call("b", input)' })
    await assert.rejects(runSkill(store, a, 1, { maxDepth: 2 }), CompositionError)
  })

  test('capability escalation is rejected', async () => {
    addVerified({ name: 'net-sub', impl: 'return input', caps: ['net'] })
    const id = addVerified({ name: 'caller2', impl: 'return call("net-sub", input)', caps: [] })
    await assert.rejects(runSkill(store, id, 1), CompositionError)
  })

  test('quarantining a sub-skill cascades to dependent composed skills', () => {
    const b = addVerified({ name: 'B', impl: 'return 1' })
    const a = addVerified({ name: 'A', impl: 'return call("B", input)', deps: [b] })
    store.updateStatus(b, 'quarantined')
    const affected = quarantineCascade(store, b)
    assert.deepEqual(affected, [a])
    assert.equal(store.get(a)?.status, 'quarantined')
  })
})
