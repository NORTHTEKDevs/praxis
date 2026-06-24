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
  // 'code' | 'line' | 'block' | a quote char (the open string delimiter)
  let state = 'code'
  while (i < n) {
    const c = impl[i]
    const c2 = impl[i + 1]
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { state = c; i++; continue }
      if (c === 'c' && (i === 0 || !/[\w$]/.test(impl[i - 1]))) {
        const m = CALL_AT.exec(impl.slice(i))
        if (m) { names.add(m[2]); i += m[0].length; continue }
      }
      i++
      continue
    }
    if (state === 'line') { if (c === '\n') state = 'code'; i++; continue }
    if (state === 'block') { if (c === '*' && c2 === '/') { state = 'code'; i += 2 } else i++; continue }
    // inside a string/template literal: skip contents, honoring escapes
    if (c === '\\') { i += 2; continue }
    if (c === state) state = 'code'
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
