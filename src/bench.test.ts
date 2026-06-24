import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runBench } from './bench.ts'

describe('praxis benchmark (synthetic)', () => {
  test('capability accumulation + bounded cost + negatives delta + under 60s', async () => {
    const start = Date.now()
    const off = await runBench('off')
    const on = await runBench('on')

    // capability reuse: repeated head tasks are solved by retrieving an existing skill
    assert.ok(off.reuseRateHead > 0.4, `reuseRateHead=${off.reuseRateHead}`)
    // sublinear library growth in the dedup-friendly head (5 skills << 20 tasks)
    assert.ok(off.libraryAfterHead < off.headTasks, `library=${off.libraryAfterHead} tasks=${off.headTasks}`)
    // context cost stays within the token budget regardless of growth
    assert.ok(off.maxTokensPerTask <= 800, `maxTokens=${off.maxTokensPerTask}`)
    // negatives ON warns before a repeat; OFF does not
    assert.ok(on.repeatFailures < off.repeatFailures, `on=${on.repeatFailures} off=${off.repeatFailures}`)
    assert.ok(Date.now() - start < 60_000, 'bench exceeded the 60s CI budget')
  })

  test('benchmark README labels itself SYNTHETIC near the top', () => {
    const txt = readFileSync(new URL('../bench/README.md', import.meta.url), 'utf8')
    assert.match(txt.slice(0, 400), /SYNTHETIC/)
  })
})
