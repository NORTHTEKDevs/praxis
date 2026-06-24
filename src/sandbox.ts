import { runInNewContext } from 'node:vm'

export type FailCategory = 'assertion' | 'runtime' | 'timeout'

export interface SandboxResult {
  ok: boolean
  category?: FailCategory
  error?: string
}

// Run a skill's implementation as `run(input)` and execute its acceptance test.
// v1 isolation: node:vm + hard timeout. NOTE: node:vm is NOT a security boundary
// (escapable). Adequate for verifying the agent's OWN generated skills; harden
// (isolated-vm / subprocess) before executing untrusted third-party skills in a
// hosted multi-tenant tier.
export function runAcceptance(
  implementation: string,
  acceptanceTest: string,
  timeoutMs = 2000,
): SandboxResult {
  const harness =
    'const run = (input) => { ' +
    implementation +
    ' };\n' +
    'const assert = (cond, msg) => { if (!cond) { const e = new Error(msg || "ACCEPTANCE_FAILED"); e.name = "AcceptanceError"; throw e; } };\n' +
    acceptanceTest +
    ';\ntrue;'
  try {
    runInNewContext(harness, {}, { timeout: timeoutMs })
    return { ok: true }
  } catch (e) {
    const err = e as { message?: string; name?: string }
    const msg = String(err?.message ?? e)
    if (/timed out/i.test(msg)) return { ok: false, category: 'timeout', error: msg }
    if (err?.name === 'AcceptanceError' || /ACCEPTANCE_FAILED/.test(msg)) {
      return { ok: false, category: 'assertion', error: msg }
    }
    return { ok: false, category: 'runtime', error: msg }
  }
}
