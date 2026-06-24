import { Praxis } from './praxis.ts'

export interface BenchStep {
  task: number
  phase: 'head' | 'tail'
  verified: number
  reused: boolean
  tokensPerTask: number
  retrievalMs: number
}

export interface BenchSummary {
  arm: 'on' | 'off'
  steps: BenchStep[]
  reuseRateHead: number
  libraryAfterHead: number
  headTasks: number
  maxTokensPerTask: number
  repeatFailures: number
}

const BASE = [
  { name: 'reverse', impl: 'return input.split("").reverse().join("")', test: 'assert(run("ab") === "ba"); assert(run("abc") === "cba")', iface: '(s:string)->string', task: 'reverse a string' },
  { name: 'double', impl: 'return input * 2', test: 'assert(run(3) === 6); assert(run(0) === 0)', iface: '(n:number)->number', task: 'double a number' },
  { name: 'inc', impl: 'return input + 1', test: 'assert(run(3) === 4); assert(run(-1) === 0)', iface: '(n:number)->number', task: 'increment a number' },
  { name: 'square', impl: 'return input * input', test: 'assert(run(3) === 9); assert(run(2) === 4)', iface: '(n:number)->number', task: 'square a number' },
  { name: 'negate', impl: 'return -input', test: 'assert(run(3) === -3); assert(run(-2) === 2)', iface: '(n:number)->number', task: 'negate a number' },
]

const TAIL = 20

// SYNTHETIC benchmark: an author-designed task stream. The head (5 patterns x 4 variants)
// models repeated work that should dedup + be reused; the tail (20 unique tasks) models a
// realistic long tail that grows linearly. Existence proof, not a general-performance claim.
export async function runBench(arm: 'on' | 'off'): Promise<BenchSummary> {
  const px = new Praxis()
  const steps: BenchStep[] = []
  let reusedHead = 0
  let repeatFailures = 0
  let n = 0

  const step = async (phase: 'head' | 'tail', query: string, learn: () => Promise<unknown>): Promise<boolean> => {
    n++
    const rec = await px.recall(query, { k: 3, tokenBudget: 800 })
    const reused = rec.selected.length > 0
    if (!reused) await learn()
    steps.push({ task: n, phase, verified: px.stats().verified, reused, tokensPerTask: rec.costEstimate, retrievalMs: rec.retrievalMs })
    return reused
  }

  // HEAD: 4 passes over 5 base patterns -> first pass learns, later passes reuse.
  for (let v = 0; v < 4; v++) {
    for (const b of BASE) {
      const reused = await step('head', b.task, () =>
        px.remember({ name: b.name, interface: b.iface, implementation: b.impl, acceptanceTest: b.test, task: b.task }),
      )
      if (v > 0 && reused) reusedHead++
    }
  }
  const libraryAfterHead = px.stats().verified
  const headTasks = n

  // TAIL: unique tasks -> linear growth.
  for (let i = 0; i < TAIL; i++) {
    const task = `unique task number ${i} alpha${i} beta${i}`
    await step('tail', task, () =>
      px.remember({ name: `tail-${i}`, interface: '(x)->y', implementation: `return input + ${i}`, acceptanceTest: `assert(run(0) === ${i}); assert(run(1) === ${i + 1})`, task }),
    )
  }

  // NEGATIVE arm: record a known failure, then measure whether a retry is warned.
  if (arm === 'on') {
    await px.recordFailure({ task: 'reverse a string', approach: 'regex', reason: 'regex fails on multi-byte chars' })
  }
  for (let i = 0; i < 10; i++) {
    const rec = await px.recall('reverse a string', { k: 3 })
    if (rec.negatives.length === 0) repeatFailures++
  }

  const maxTokensPerTask = steps.reduce((m, s) => Math.max(m, s.tokensPerTask), 0)
  return { arm, steps, reuseRateHead: reusedHead / (BASE.length * 3), libraryAfterHead, headTasks, maxTokensPerTask, repeatFailures }
}
