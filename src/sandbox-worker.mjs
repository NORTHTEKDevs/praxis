// Plain ESM worker (no TypeScript -> loads in a Worker without type-stripping flags).
// Two modes:
//   verify: run the acceptance test; report ok / assertion / runtime / timeout / async
//   exec:   run the implementation on an input; report the returned value
// Both inject a synchronous call(name, input) resolver so COMPOSED skills (whose code
// calls verified sub-skills by name) work in either mode. Isolation: this runs inside a
// worker thread with a host-set memory cap + timeout (host terminates on its own clock).
//
// Trust design:
//  - assert() records the failure to the sandbox BEFORE throwing, so a try/catch in the
//    acceptance test cannot swallow it.
//  - run() rejects async implementations (a pending Promise would pass a truthiness check).
//  - the implementation/acceptance test are built with `new Function`, so they run in the
//    context global scope and cannot reach into the worker's module scope.
import { parentPort, workerData } from 'node:worker_threads'
import vm from 'node:vm'

const { mode, implementation, acceptanceTest, input, subImpls = {}, maxDepth = 5, timeoutMs } = workerData

const sandbox = {
  __af: [],
  __ac: 0,
  __subs: subImpls,
  __maxDepth: maxDepth,
  __impl: implementation,
  __accept: acceptanceTest ?? '',
  __input: input,
  __result: undefined,
  __mode: mode,
}

const code = `
const __subFns = {};
let __depth = 0;
const call = (name, inp) => {
  if (!Object.prototype.hasOwnProperty.call(__subs, name)) throw new Error("unknown sub-skill: " + name);
  if (__depth >= __maxDepth) throw new Error("max composition depth exceeded");
  if (!__subFns[name]) __subFns[name] = new Function("input", "call", __subs[name]);
  __depth++;
  try { return __subFns[name](inp, call); } finally { __depth--; }
};
const __run = new Function("input", "call", __impl);
const run = (input) => {
  const r = __run(input, call);
  if (r && typeof r.then === "function") { const e = new Error("ASYNC_SKILL"); e.name = "AsyncError"; throw e; }
  return r;
};
const assert = (cond, msg) => { __ac++; if (!cond) { __af.push(String(msg || "ACCEPTANCE_FAILED")); throw new Error("ACCEPTANCE_FAILED"); } };
if (__mode === "exec") {
  __result = run(__input);
} else {
  const __acc = new Function("run", "assert", "call", __accept);
  __acc(run, assert, call);
}
`

try {
  vm.runInNewContext(code, sandbox, { timeout: timeoutMs })
  if (mode === 'exec') parentPort.postMessage({ ok: true, value: sandbox.__result })
  else if (sandbox.__af.length > 0) parentPort.postMessage({ ok: false, category: 'assertion', error: sandbox.__af[0] })
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
