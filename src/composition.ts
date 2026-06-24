import { SkillStore } from './store.ts'

// Matches call('name'), call("name"), or call(`name`) at the current scan position.
const CALL_AT = /^call\s*\(\s*(['"`])([^'"`]+)\1/

export class CompositionError extends Error {}

export interface CompositionResolution {
  ok: boolean
  subImpls: Record<string, string>
  deps: string[]
  reason?: string
}

// Extract the sub-skill names a piece of code references via call('name', ...). A small
// scanner that tracks string/comment state so call( inside a comment or a string literal
// is NOT mistaken for a real dependency, and all three quote styles for the name are
// recognized. (Full JS parsing is overkill for v1; this covers the real false-positive /
// bypass cases the audit found.)
export function parseCalls(impl: string): string[] {
  const names = new Set<string>()
  const n = impl.length
  let i = 0
  // stack of frames; top is the active lexer state. 'interp' is the code inside a template
  // literal ${...} and tracks its own brace depth so nested {} do not close it early.
  const stack: Array<{ kind: string; depth: number }> = [{ kind: 'code', depth: 0 }]
  const top = () => stack[stack.length - 1]
  while (i < n) {
    const f = top()
    const c = impl[i]
    const c2 = impl[i + 1]
    if (f.kind === 'code' || f.kind === 'interp') {
      if (c === '/' && c2 === '/') { stack.push({ kind: 'line', depth: 0 }); i += 2; continue }
      if (c === '/' && c2 === '*') { stack.push({ kind: 'block', depth: 0 }); i += 2; continue }
      if (c === "'") { stack.push({ kind: 'sq', depth: 0 }); i++; continue }
      if (c === '"') { stack.push({ kind: 'dq', depth: 0 }); i++; continue }
      if (c === '`') { stack.push({ kind: 'tpl', depth: 0 }); i++; continue }
      if (f.kind === 'interp') {
        if (c === '{') { f.depth++; i++; continue }
        if (c === '}') { if (f.depth === 0) stack.pop(); else f.depth--; i++; continue }
      }
      // word-boundary so recall()/myCall() do not match. NOTE: a call() inside a regex
      // literal (e.g. /call("x")/) is a FALSE POSITIVE here -> the skill is quarantined
      // (fails CLOSED, safe). We do NOT exclude a preceding '/', because that would silently
      // DROP a real dependency after a division operator (x/call("dep")) - the dangerous
      // direction. Regex-with-call() in skill code is the rare, safe-to-reject case.
      if (c === 'c' && (i === 0 || !/[\w$]/.test(impl[i - 1]))) {
        const m = CALL_AT.exec(impl.slice(i))
        if (m) { names.add(m[2]); i += m[0].length; continue }
      }
      i++
      continue
    }
    if (f.kind === 'line') { if (c === '\n') stack.pop(); i++; continue }
    if (f.kind === 'block') { if (c === '*' && c2 === '/') { stack.pop(); i += 2 } else i++; continue }
    if (f.kind === 'sq') { if (c === '\\') i += 2; else { if (c === "'") stack.pop(); i++ } continue }
    if (f.kind === 'dq') { if (c === '\\') i += 2; else { if (c === '"') stack.pop(); i++ } continue }
    // template literal: skip text, enter 'interp' on ${, honor escapes, close on backtick
    if (c === '\\') { i += 2; continue }
    if (c === '$' && c2 === '{') { stack.push({ kind: 'interp', depth: 0 }); i += 2; continue }
    if (c === '`') stack.pop()
    i++
  }
  return [...names]
}

// Host-side static validation of a composed skill BEFORE it runs:
//  - every referenced sub-skill exists and is VERIFIED
//  - no cycles
//  - no capability escalation (a sub-skill cannot require a capability the parent lacks)
//  - composition depth <= maxDepth
// Returns the flat {name -> implementation} map the sandbox needs for its call resolver.
export function resolveComposition(
  store: SkillStore,
  impl: string,
  parentCaps: string[],
  maxDepth = 5,
): CompositionResolution {
  const subImpls: Record<string, string> = {}
  const deps: string[] = []

  const visit = (code: string, seen: string[], depth: number): string | null => {
    if (depth > maxDepth) return 'max composition depth exceeded'
    for (const name of parseCalls(code)) {
      if (seen.includes(name)) return `cyclic dependency: ${[...seen, name].join(' -> ')}`
      const sub = store.findVerifiedByName(name)
      if (!sub) return `unknown or unverified sub-skill: ${name}`
      for (const cap of sub.capabilities) {
        if (!parentCaps.includes(cap)) return `capability escalation: sub-skill '${name}' requires '${cap}'`
      }
      subImpls[name] = sub.implementation
      if (!deps.includes(sub.id)) deps.push(sub.id)
      const err = visit(sub.implementation, [...seen, name], depth + 1)
      if (err) return err
    }
    return null
  }

  const reason = visit(impl, [], 1)
  if (reason) return { ok: false, subImpls: {}, deps: [], reason }
  return { ok: true, subImpls, deps }
}

// When a skill is demoted out of 'verified', any composed skill that depends on it can no
// longer be trusted (it passed its acceptance test against a sub-skill that is now gone).
// Cascade quarantine to all transitive dependents. Returns the affected skill ids.
export function quarantineCascade(store: SkillStore, id: string, reason = 'sub-skill invalidated'): string[] {
  const affected: string[] = []
  void reason
  const walk = (depId: string) => {
    for (const parent of store.dependentsOf(depId)) {
      const p = store.get(parent)
      if (p && p.status === 'verified') {
        store.updateStatus(parent, 'quarantined')
        affected.push(parent)
        walk(parent)
      }
    }
  }
  walk(id)
  return affected
}
