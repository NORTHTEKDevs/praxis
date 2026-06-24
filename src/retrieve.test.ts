import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SkillStore } from './store.ts'
import { HashingEmbedder } from './embedder.ts'
import { recall } from './retrieve.ts'
import { captureSkill } from './capture.ts'
import type { SkillKind, SkillStatus } from './skill.ts'

const embedder = new HashingEmbedder()

interface AddOpts {
  name: string
  task: string
  interface?: string
  kind?: SkillKind
  status?: SkillStatus
  utility?: number
}

async function add(store: SkillStore, opts: AddOpts): Promise<string> {
  const s = captureSkill({
    name: opts.name,
    interface: opts.interface ?? '(x)->y',
    implementation: 'return input',
    acceptanceTest: 'assert(run(1) === 1)',
    task: opts.task,
    kind: opts.kind,
  })
  s.embedding = await embedder.embed(`${s.name} ${s.interface} ${s.provenance.task}`)
  s.status = opts.status ?? 'verified'
  s.utilityScore = opts.utility ?? 0
  return store.insert(s)
}

describe('recall (budgeted top-k)', () => {
  let store: SkillStore
  beforeEach(() => {
    store = new SkillStore(':memory:')
  })

  test('returns at most k and at most 1 negative with a large library', async () => {
    for (let i = 0; i < 1000; i++) await add(store, { name: `skill-${i}`, task: `parse data variant ${i}` })
    await add(store, { name: 'neg-1', task: 'parse data badly', kind: 'negative' })
    const r = await recall(store, embedder, 'parse data variant 7', { k: 5 })
    assert.ok(r.selected.length <= 5)
    assert.ok(r.negatives.length <= 1)
  })

  test('context cost stays within tokenBudget regardless of library size', async () => {
    const s50 = new SkillStore(':memory:')
    for (let i = 0; i < 50; i++) await add(s50, { name: `s${i}`, task: `parse json ${i}` })
    const big = new SkillStore(':memory:')
    for (let i = 0; i < 1000; i++) await add(big, { name: `s${i}`, task: `parse json ${i}` })
    const a = await recall(s50, embedder, 'parse json 3', { k: 5, tokenBudget: 1000 })
    const b = await recall(big, embedder, 'parse json 3', { k: 5, tokenBudget: 1000 })
    assert.ok(a.costEstimate <= 1000)
    assert.ok(b.costEstimate <= 1000)
  })

  test('higher-utility skill outranks equal-cosine lower-utility skill', async () => {
    await add(store, { name: 'dup', interface: '(s)->s', task: 'reverse a string', utility: 0 })
    const highId = await add(store, { name: 'dup', interface: '(s)->s', task: 'reverse a string', utility: 10 })
    const r = await recall(store, embedder, 'reverse a string', { k: 2 })
    assert.equal(r.selected[0].id, highId)
  })

  test('relevant negative surfaces even when selected is full', async () => {
    for (let i = 0; i < 5; i++) await add(store, { name: `p${i}`, task: 'nested json parse' })
    await add(store, { name: 'neg', task: 'nested json parse', kind: 'negative' })
    const r = await recall(store, embedder, 'nested json parse', { k: 2 })
    assert.equal(r.selected.length, 2)
    assert.equal(r.negatives.length, 1)
  })

  test('no negatives in library -> empty negatives, not error', async () => {
    await add(store, { name: 'p', task: 'sort numbers' })
    const r = await recall(store, embedder, 'sort numbers', { k: 5 })
    assert.deepEqual(r.negatives, [])
  })
})
