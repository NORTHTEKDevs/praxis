import { Praxis } from './praxis.ts'
import { consolidate } from './consolidate.ts'

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: ToolHandler
}

// Every MCP tool call goes through this: a thrown error becomes an MCP error ENVELOPE
// (isError:true), never an uncaught exception that surfaces as a cryptic transport error.
export async function wrapTool(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const r = await fn()
    return { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }] }
  } catch (e) {
    const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)
    return { content: [{ type: 'text', text: msg }], isError: true }
  }
}

const str = (description: string) => ({ type: 'string', description })

export function buildTools(px: Praxis): ToolDef[] {
  return [
    {
      name: 'remember_skill',
      description: 'Capture a solved task as a skill. Kept ONLY if its acceptance test passes in the sandbox (verify-before-keep).',
      inputSchema: {
        type: 'object',
        required: ['name', 'implementation', 'acceptanceTest', 'task'],
        properties: {
          name: str('skill name'),
          interface: str('typed signature, e.g. (n:number)->number'),
          implementation: str('JS function body using `input` (and call("name",x) for sub-skills): return ...'),
          acceptanceTest: str('assert(run(x) === expected) -- needs >=1 concrete expected value'),
          task: str('what the skill does'),
          capabilities: { type: 'array', items: { type: 'string' }, description: 'declared side effects' },
        },
        additionalProperties: false,
      },
      handler: (a) => px.remember(a as never),
    },
    {
      name: 'recall_skills',
      description: 'Retrieve the top-k verified skills for a query, plus known failure modes (negatives) to check before retrying.',
      inputSchema: { type: 'object', required: ['query'], properties: { query: str('task description'), k: { type: 'number', maximum: 50 }, tokenBudget: { type: 'number' }, maxNegatives: { type: 'number', maximum: 20, description: 'max known-failure modes to return (default 1)' } } },
      handler: async (a) => {
        const k = Math.min((a.k as number) ?? 5, 50)
        const maxNegatives = Math.min((a.maxNegatives as number) ?? 1, 20)
        const r = await px.recall(String(a.query), { k, tokenBudget: a.tokenBudget as number, maxNegatives })
        return { skills: r.selected, negatives: r.negatives, costEstimate: r.costEstimate }
      },
    },
    {
      name: 'run_skill',
      description: 'Execute a verified skill (composing verified sub-skills if its code calls them) on an input.',
      inputSchema: { type: 'object', required: ['id', 'input'], properties: { id: str('skill id'), input: { description: 'the input value' } } },
      handler: (a) => px.run(String(a.id), a.input),
    },
    {
      name: 'record_failure',
      description: 'Record a known failure mode as a first-class negative skill, surfaced before similar retries.',
      inputSchema: { type: 'object', required: ['task', 'approach', 'reason'], properties: { task: { type: 'string', description: 'the task', maxLength: 2000 }, approach: { type: 'string', description: 'what was tried', maxLength: 2000 }, reason: { type: 'string', description: 'why it failed', maxLength: 2000 } } },
      handler: (a) => px.recordFailure(a as never),
    },
    {
      name: 'reinforce',
      description: "Record a usage outcome. 'failure' re-runs the acceptance test; a now-broken skill is quarantined.",
      inputSchema: { type: 'object', required: ['id', 'outcome'], properties: { id: str('skill id'), outcome: { type: 'string', enum: ['success', 'failure'] } } },
      handler: (a) => px.reinforce(String(a.id), a.outcome as 'success' | 'failure'),
    },
    {
      name: 'library_stats',
      description: 'Library health: total/verified/quarantined/negatives, tier counts, weak-test count, top skills.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => px.stats(),
    },
    {
      name: 'pin_skill',
      description: 'Pin a skill so it is never evicted or demoted by tiering.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: str('skill id'), pinned: { type: 'boolean' } } },
      handler: async (a) => {
        px.pin(String(a.id), a.pinned !== false)
        return { ok: true }
      },
    },
    {
      name: 'consolidate_now',
      description: 'Run a consolidation pass: regression-safe dedup-merge + cold eviction.',
      inputSchema: { type: 'object', properties: { dryRun: { type: 'boolean' } } },
      handler: (a) => consolidate(px.store, px.embedder, { dryRun: a.dryRun as boolean, hotCap: px.hotCap }),
    },
  ]
}
