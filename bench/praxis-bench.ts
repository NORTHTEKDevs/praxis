import { writeFileSync } from 'node:fs'
import { runBench } from '../src/bench.ts'

// SYNTHETIC benchmark runner. Writes results.json + results.csv next to this file.
// Run: node --experimental-strip-types --experimental-sqlite bench/praxis-bench.ts
const on = await runBench('on')
const off = await runBench('off')

const results = {
  synthetic: true,
  embedder: 'hashing-v1',
  capability_growth: { reuseRateHead: off.reuseRateHead },
  library_size: { libraryAfterHead: off.libraryAfterHead, headTasks: off.headTasks, totalAfterTail: off.steps.at(-1)?.verified ?? 0 },
  context_cost: { maxTokensPerTask: off.maxTokensPerTask },
  retrieval_latency: { maxRetrievalMs: off.steps.reduce((m, s) => Math.max(m, s.retrievalMs), 0) },
  repeat_error_delta: { negatives_on: on.repeatFailures, negatives_off: off.repeatFailures },
}

const here = new URL('.', import.meta.url)
writeFileSync(new URL('results.json', here), JSON.stringify(results, null, 2))

const header = 'task,phase,verified,reused,tokensPerTask,retrievalMs'
const rows = off.steps.map((s) => `${s.task},${s.phase},${s.verified},${s.reused},${s.tokensPerTask},${s.retrievalMs.toFixed(2)}`)
writeFileSync(new URL('results.csv', here), [header, ...rows].join('\n'))

console.log('SYNTHETIC benchmark complete:')
console.log(JSON.stringify(results, null, 2))
