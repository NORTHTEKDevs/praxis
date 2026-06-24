import { Worker } from 'node:worker_threads'

export type FailCategory = 'assertion' | 'runtime' | 'timeout' | 'memory' | 'async'

export interface SandboxResult {
  ok: boolean
  category?: FailCategory
  error?: string
}

const WORKER_URL = new URL('./sandbox-worker.mjs', import.meta.url)

// Run the acceptance test in an isolated worker thread with a hard memory cap
// (maxOldGenerationSizeMb) and a host-enforced timeout. An OOM/runaway skill kills the
// WORKER, never the host process. This is "isolated with a hard memory cap and timeout
// kill" -- NOT a hardened multi-tenant security boundary (v1.1 upgrade path: isolated-vm).
export function runAcceptance(
  implementation: string,
  acceptanceTest: string,
  timeoutMs = 2000,
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    let settled = false
    const worker = new Worker(WORKER_URL, {
      workerData: { implementation, acceptanceTest, timeoutMs },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    })
    const finish = (r: SandboxResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      resolve(r)
    }
    const timer = setTimeout(
      () => finish({ ok: false, category: 'timeout', error: 'execution timed out (host kill)' }),
      timeoutMs + 1000,
    )
    worker.on('message', (m: SandboxResult) => finish(m))
    worker.on('error', (err: Error) => {
      const msg = String(err?.message ?? err)
      finish({ ok: false, category: /memory|heap|allocation/i.test(msg) ? 'memory' : 'runtime', error: msg })
    })
    worker.on('exit', (code: number) => {
      if (code !== 0) finish({ ok: false, category: 'memory', error: `worker exited with code ${code}` })
    })
  })
}
