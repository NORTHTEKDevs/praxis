import { Worker } from 'node:worker_threads'

export type FailCategory = 'assertion' | 'runtime' | 'timeout' | 'memory' | 'async'

export interface SandboxResult {
  ok: boolean
  category?: FailCategory
  error?: string
  value?: unknown
}

export interface SandboxOpts {
  timeoutMs?: number
  subImpls?: Record<string, string>
  maxDepth?: number
}

const WORKER_URL = new URL('./sandbox-worker.mjs', import.meta.url)

// Run a job in an isolated worker thread with a hard memory cap (maxOldGenerationSizeMb)
// and a host-enforced timeout. An OOM/runaway skill kills the WORKER, never the host.
// "Isolated with a hard memory cap and timeout kill" -- NOT a hardened multi-tenant
// security boundary (v1.1 upgrade: isolated-vm).
function runWorker(workerData: Record<string, unknown>, timeoutMs: number): Promise<SandboxResult> {
  return new Promise((resolve) => {
    let settled = false
    const worker = new Worker(WORKER_URL, { workerData, resourceLimits: { maxOldGenerationSizeMb: 64 } })
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

// verify mode: execute the acceptance test, returning pass/fail category.
export function runAcceptance(
  implementation: string,
  acceptanceTest: string,
  opts: SandboxOpts = {},
): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? 2000
  return runWorker(
    { mode: 'verify', implementation, acceptanceTest, subImpls: opts.subImpls ?? {}, maxDepth: opts.maxDepth ?? 5, timeoutMs },
    timeoutMs,
  )
}

// exec mode: run the implementation on an input, returning its value.
export function runValue(implementation: string, input: unknown, opts: SandboxOpts = {}): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? 2000
  return runWorker(
    { mode: 'exec', implementation, input, subImpls: opts.subImpls ?? {}, maxDepth: opts.maxDepth ?? 5, timeoutMs },
    timeoutMs,
  )
}
