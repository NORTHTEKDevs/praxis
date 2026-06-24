// Plain ESM worker (no TypeScript -> loads in a Worker without type-stripping flags).
// Runs a skill's implementation as run(input) and executes its acceptance test inside
// node:vm, isolated in this worker thread with a hard memory cap (set by the host via
// resourceLimits) and a sync timeout. The host terminates this worker on its own clock.
//
// Trust design:
//  - assert() records the failure to the sandbox object BEFORE throwing, so a malicious
//    acceptance test that wraps assert in try/catch cannot swallow the failure: the host
//    reads sandbox.__af afterward.
//  - run() rejects async implementations (a pending Promise is truthy and would pass a
//    truthiness check vacuously) -> verify-before-keep stays honest.
//  - vm is NOT a hardened security boundary; the worker + memory cap + timeout protect the
//    HOST from OOM/runaway, which is the v1 threat model (trusted user's own agent code).
import { parentPort, workerData } from 'node:worker_threads'
import vm from 'node:vm'

const { implementation, acceptanceTest, timeoutMs } = workerData
const sandbox = { __af: [], __ac: 0 }
const harness =
  'const __run = (input) => { ' + implementation + ' };' +
  'const run = (input) => { const r = __run(input); if (r && typeof r.then === "function") { const e = new Error("ASYNC_SKILL"); e.name = "AsyncError"; throw e; } return r; };' +
  'const assert = (cond, msg) => { __ac++; if (!cond) { __af.push(String(msg || "ACCEPTANCE_FAILED")); throw new Error("ACCEPTANCE_FAILED"); } };' +
  acceptanceTest + ';true;'

try {
  vm.runInNewContext(harness, sandbox, { timeout: timeoutMs })
  if (sandbox.__af.length > 0) parentPort.postMessage({ ok: false, category: 'assertion', error: sandbox.__af[0] })
  else if (sandbox.__ac === 0) parentPort.postMessage({ ok: false, category: 'runtime', error: 'no assertions executed' })
  else parentPort.postMessage({ ok: true })
} catch (e) {
  const msg = String((e && e.message) || e)
  let category = 'runtime'
  if (/timed out/i.test(msg)) category = 'timeout'
  else if (/ASYNC_SKILL/.test(msg) || (e && e.name === 'AsyncError')) category = 'async'
  else if (sandbox.__af.length > 0 || /ACCEPTANCE_FAILED/.test(msg)) category = 'assertion'
  parentPort.postMessage({ ok: false, category, error: msg })
}
