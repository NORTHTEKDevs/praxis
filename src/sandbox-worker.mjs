// Plain ESM worker (no TypeScript -> loads in a Worker without type-stripping flags).
// Two modes: verify (run the acceptance test) and exec (run the implementation on an input).
// Both inject a synchronous call(name, input) resolver so COMPOSED skills work in either mode.
// Isolation: runs inside a worker thread with a host-set memory cap + timeout (host kills it).
//
// Trust design:
//  - The assertion bookkeeping (assert count + failures) lives inside an IIFE closure, NOT on
//    the sandbox object, so a crafted acceptance test cannot zero it to spoof a pass. The IIFE
//    is the entire script, so its authoritative outcome is read back as the vm COMPLETION VALUE
//    (vm.runInNewContext's return), NOT through a sandbox property -- so a test cannot redefine
//    an outcome channel with a no-op setter to forge a clean result. (No host function is
//    injected into the context -> no extra escape.)
//  - run() rejects async implementations (a pending Promise would pass a truthiness check).
//  - implementation/acceptance test are built with `new Function` inside the context, so they
//    run in the context global scope and cannot reach the worker module scope.
//  vm is NOT a hardened security boundary; the worker + memory cap + timeout protect the HOST,
//  which is the v1 single-tenant threat model.
import { parentPort, workerData } from 'node:worker_threads'
import vm from 'node:vm'

const { mode, implementation, acceptanceTest, input, subImpls = {}, maxDepth = 5, timeoutMs } = workerData

// Only DATA goes on the sandbox; the verification outcome is computed in-context and read back.
const sandbox = {
  __subs: subImpls,
  __maxDepth: maxDepth,
  __impl: implementation,
  __accept: acceptanceTest ?? '',
  __input: input,
  __mode: mode,
}

const code = `
;(() => {
  // Capture the control structures into closure consts and DELETE them from the vm global so
  // skill code (which runs in the global scope via new Function) cannot mutate __subs to inject
  // an unverified sub-skill body, nor lift __maxDepth.
  const __subs = globalThis.__subs;
  const __maxDepth = globalThis.__maxDepth;
  const __impl = globalThis.__impl;
  const __accept = globalThis.__accept;
  const __input = globalThis.__input;
  const __mode = globalThis.__mode;
  delete globalThis.__subs;
  delete globalThis.__maxDepth;
  delete globalThis.__impl;
  delete globalThis.__accept;
  delete globalThis.__input;
  delete globalThis.__mode;
  let ac = 0;
  const af = [];
  const assert = (cond, msg) => { ac++; if (!cond) { af.push(String(msg || "ACCEPTANCE_FAILED")); const e = new Error("ACCEPTANCE_FAILED"); e.name = "AcceptanceError"; throw e; } };
  const __subFns = Object.create(null);
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
  let result;
  let err = null;
  try {
    if (__mode === "exec") { result = run(__input); }
    else { const __acc = new Function("run", "assert", "call", __accept); __acc(run, assert, call); }
  } catch (e) { err = e; }
  return {
    ac, af, result,
    threw: !!err,
    errorMessage: err ? String((err && err.message) || err) : null,
    errorName: err ? err.name : null,
  };
})();
`

let posted = false
let outcome
try {
  // The outcome is the script's completion value (the IIFE's return), read directly from the
  // host -- never via a sandbox property the in-context code could trap.
  outcome = vm.runInNewContext(code, sandbox, { timeout: timeoutMs })
} catch (e) {
  // vm-level failure: timeout interrupt, or a syntax error in the generated code.
  const msg = String((e && e.message) || e)
  const category = (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') || /timed out/i.test(msg) ? 'timeout' : 'runtime'
  parentPort.postMessage({ ok: false, category, error: msg })
  posted = true
}

if (!posted) {
  const o = outcome || { ac: 0, af: [], threw: true, errorMessage: 'no outcome', errorName: null }
  const classify = () => {
    const m = o.errorMessage || ''
    if (o.errorName === 'AsyncError' || /ASYNC_SKILL/.test(m)) return 'async'
    if (/timed out/i.test(m)) return 'timeout'
    // 'assertion' ONLY when the trusted assert closure recorded a failure (it always pushes to
    // af BEFORE throwing). A bare AcceptanceError with an empty af was NOT raised by assert -- it
    // is a forged/broken test, so it falls through to 'runtime' -> quarantined (test error), not
    // 'refuted' (which wrongly implies the implementation is wrong).
    if (o.af.length > 0) return 'assertion'
    return 'runtime'
  }
  if (mode === 'exec') {
    if (o.threw) parentPort.postMessage({ ok: false, category: classify(), error: o.errorMessage })
    else {
      try {
        parentPort.postMessage({ ok: true, value: o.result })
      } catch (e) {
        parentPort.postMessage({ ok: false, category: 'runtime', error: 'result not structured-cloneable: ' + String((e && e.message) || e) })
      }
    }
  } else if (o.af.length > 0) {
    parentPort.postMessage({ ok: false, category: 'assertion', error: o.af[0] })
  } else if (o.threw) {
    parentPort.postMessage({ ok: false, category: classify(), error: o.errorMessage })
  } else if (o.ac === 0) {
    parentPort.postMessage({ ok: false, category: 'runtime', error: 'no assertions executed' })
  } else {
    parentPort.postMessage({ ok: true })
  }
}
