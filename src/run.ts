import { SkillStore } from './store.ts'
import { runValue } from './sandbox.ts'
import { resolveComposition, CompositionError, parseCalls } from './composition.ts'

export interface RunResult {
  output: unknown
  durationMs: number
}

// Execute a verified skill on an input. If the skill composes other skills (its code
// calls call('name', ...)), the dependency graph is validated host-side first; only a
// fully-verified, acyclic, non-escalating composition is allowed to run.
export async function runSkill(
  store: SkillStore,
  id: string,
  input: unknown,
  opts: { maxDepth?: number; timeoutMs?: number } = {},
): Promise<RunResult> {
  const skill = store.get(id)
  if (!skill) throw new Error(`runSkill: no skill with id ${id}`)
  const maxDepth = opts.maxDepth ?? 5

  let subImpls: Record<string, string> = {}
  if (parseCalls(skill.implementation).length > 0) {
    const comp = resolveComposition(store, skill.implementation, skill.capabilities, maxDepth)
    if (!comp.ok) throw new CompositionError(comp.reason)
    subImpls = comp.subImpls
  }

  const start = Date.now()
  const r = await runValue(skill.implementation, input, { subImpls, maxDepth, timeoutMs: opts.timeoutMs })
  if (!r.ok) throw new Error(r.error ?? 'run failed')
  return { output: r.value, durationMs: Date.now() - start }
}
