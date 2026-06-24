import { SkillStore } from './store.ts'

const CALL_RE = /call\s*\(\s*['"]([^'"]+)['"]/g

export class CompositionError extends Error {}

export interface CompositionResolution {
  ok: boolean
  subImpls: Record<string, string>
  deps: string[]
  reason?: string
}

// Extract the sub-skill names a piece of code references via call('name', ...).
export function parseCalls(impl: string): string[] {
  const names = new Set<string>()
  let m: RegExpExecArray | null
  CALL_RE.lastIndex = 0
  while ((m = CALL_RE.exec(impl)) !== null) names.add(m[1])
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
