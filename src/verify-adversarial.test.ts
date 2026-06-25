import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { verifySkill } from './verify.ts'

const mk = (implementation: string, acceptanceTest: string) => ({ implementation, acceptanceTest })

// The property tests for the trust-critical invariant: no adversarial input promotes a
// skill to `verified`. If any of these regress, verify-before-keep is broken.
describe('verify gate adversarial suite', () => {
  test('assert-swallowing via try/catch is refuted, not verified', async () => {
    // The acceptance test wraps a failing assert in try/catch to hide the failure.
    // The sandbox records the failure before throwing, so the host still sees it.
    const r = await verifySkill(mk('return 1', 'try { assert(run(1) === 999) } catch (e) {}'))
    assert.equal(r.status, 'refuted')
  })

  test('memory allocation bomb does not crash host; quarantined', async () => {
    const r = await verifySkill(
      mk('const a=[]; while(true){ a.push(new Array(100000).fill(0)) }', 'assert(run(1) === 1)'),
      { timeoutMs: 1500 },
    )
    assert.equal(r.status, 'quarantined')
  })

  test('run redefinition cannot forge the acceptance result', async () => {
    // The implementation tries to reassign run() to return 999 so a 999-check passes.
    // The acceptance test's run() is the fixed outer run; the reassignment is a harmless
    // global, so the real result (input) is checked -> refuted, not verified.
    const r = await verifySkill(mk('run = () => 999; return input', 'assert(run(3) === 999)'))
    // rejected either way (the real outer run() is unaffected -> assertion fails, or the
    // reassignment errors) - the invariant is simply: NOT verified.
    assert.ok(r.status === 'quarantined' || r.status === 'refuted')
  })

  test('a tampering acceptance test cannot spoof a pass', async () => {
    // swallow a failing assert, then try to clear the (now closure-private) failure record.
    const r = await verifySkill(mk('return 1', 'try { assert(run(1) === 999) } catch (e) {} __af = []; __ac = 99'))
    assert.equal(r.status, 'refuted') // closure preserves the recorded failure; tamper is inert
  })

  test('a short-circuit-tautology acceptance test does not verify (counter-example probe)', async () => {
    // run(3) === 6 is false, but `|| true` makes the assert pass regardless of the impl.
    const r = await verifySkill(mk('return 0', 'assert(run(3) === 6 || true)'))
    assert.notEqual(r.status, 'verified')
  })

  test('an acceptance test that ignores run() entirely does not verify', async () => {
    const r = await verifySkill(mk('return 0', 'assert(run(3) === run(3) + 0 || 1 === 1)'))
    assert.notEqual(r.status, 'verified')
  })

  test('skill cannot inject an unverified sub-skill by mutating __subs', async () => {
    const r = await verifySkill(mk('const n = "ghost"; __subs[n] = "return 999"; return call(n, input)', 'assert(run(1) === 999)'))
    assert.notEqual(r.status, 'verified')
  })

  test('acceptance test cannot sniff globalThis.__impl to defeat the counter-example probe', async () => {
    // reads __impl to detect the probe stub; with __impl deleted from the global, the sniff is
    // inert in both runs and the probe catches the `|| ...` vacuity.
    const at = 'assert(run(3) === 6 || !String(globalThis.__impl).includes("praxisStub"))'
    const r = await verifySkill(mk('return 0', at))
    assert.notEqual(r.status, 'verified')
  })

  test('an acceptance test whose assert never executes does not verify (ac===0)', async () => {
    const r = await verifySkill(mk('return 1', 'if (false) { assert(run(1) === 1) }'))
    assert.notEqual(r.status, 'verified')
  })

  test('a forged AcceptanceError with no recorded assert failure is quarantined, not refuted', async () => {
    // assert once (passing) so ac>=1, then hand-throw an error NAMED AcceptanceError with an
    // empty failure log. This is a broken/spoof test, not a real assertion failure -> it must
    // quarantine (test error), never refute (which would imply the implementation is wrong).
    const at = 'assert(run(1) === 1); const e = new Error("x"); e.name = "AcceptanceError"; throw e'
    const r = await verifySkill(mk('return input', at))
    assert.equal(r.status, 'quarantined')
  })

  test('an acceptance test that crashes the probe stub instead of asserting does not verify', async () => {
    // detect the string-typed stub and throw a runtime error so the stub exits NON-assertion;
    // the real oracle (|| true) is vacuous. Requiring a clean ASSERTION rejection catches this.
    const at = 'if (typeof run(0) === "string") { throw new Error("evade") } assert(run(0) === 6 || true)'
    const r = await verifySkill(mk('return 0', at))
    assert.notEqual(r.status, 'verified')
  })

  test('an acceptance test that detects the probe stub by shape cannot dodge the vacuity check', async () => {
    // detect a stub OBJECT via the old fixed marker and throw to force probe.ok=false, while the
    // real oracle is vacuous (|| true). Marker-free randomized stubs make the detection inert.
    const at =
      'const r = run(0); if (r && typeof r === "object" && "__praxisStub" in r) throw new Error("x"); assert(run(0) === 999 || true)'
    const res = await verifySkill(mk('return 0', at))
    assert.notEqual(res.status, 'verified')
  })

  test('acceptance test cannot forge a pass by trapping the outcome channel (defineProperty)', async () => {
    // install a forged getter + no-op setter on the outcome channel, then fail a REAL assert.
    // The outcome is read as the vm completion value (not a sandbox property), so the trap is
    // inert and the genuine failure stands -> NOT verified.
    const at =
      'try { Object.defineProperty(globalThis, "__outcome", { configurable: true, get: () => ({ ac: 1, af: [], threw: false }), set() {} }) } catch (e) {} assert(run(3) === 999)'
    const r = await verifySkill(mk('return 0', at))
    assert.notEqual(r.status, 'verified')
  })

  test('100 rapid verifications all complete (no worker leak)', async () => {
    const results: string[] = []
    for (let i = 0; i < 100; i++) {
      results.push((await verifySkill(mk('return input * 2', 'assert(run(2) === 4)'))).status)
    }
    assert.equal(results.length, 100)
    assert.ok(results.every((s) => s === 'verified'))
  })
})
