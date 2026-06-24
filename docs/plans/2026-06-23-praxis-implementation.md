# Praxis Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build Praxis - an engine + MCP server that lets an agent accumulate a self-pruning, verified, composable skill library so it durably improves at the user's work without unbounded cost growth.

**Architecture:** TypeScript core. Skills are captured from solved tasks, kept ONLY if their acceptance test passes in a sandbox (verify-before-keep), deduped/merged on write, retrieved top-k within a token/cost budget (per-call cost independent of library size), composed by reference, scored by utility, and evicted/consolidated to stay lean. Surfaced over an MCP server (works with Claude Code, Cursor, any MCP client).

**Tech Stack:** Node 24 + TypeScript, vitest (tests), better-sqlite3 (storage), in-process cosine over a bounded hot set (retrieval; sqlite-vec is a later upgrade), pluggable Embedder (HashingEmbedder for deterministic/offline tests, TransformersEmbedder via @xenova/transformers for prod), worker_threads sandbox (timeout + no injected fs/net), @modelcontextprotocol/sdk (MCP).

**Environment gate:** Execution requires a healthy shell (npm install + vitest must run). The shell was degraded at planning time (slow profile-load hangs). Stabilize the shell (reboot if needed) before executing; verify with `node --version && npm --version` returning promptly.

**Doctrine:** Every task is TDD red-green. No task is "done" without captured command output showing the test run. Decompose; verify each unit before integrating. The verify gate is trust-critical and gets a property test.

---

## Phase 0 - Project setup

### Task 0: Scaffold the project

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/index.ts`, `README.md`

**Step 1: Init**
```bash
cd /c/Users/Krist/projects/active/praxis
git init
npm init -y
npm pkg set type=module
npm i better-sqlite3 @modelcontextprotocol/sdk
npm i -D typescript vitest @types/node @types/better-sqlite3 tsx
npm i @xenova/transformers   # prod embedder; tests use HashingEmbedder, no network
```

**Step 2: tsconfig.json**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

**Step 3: vitest.config.ts**
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['src/**/*.test.ts'], testTimeout: 20000 } })
```

**Step 4: .gitignore**
```
node_modules
dist
*.db
.env*
.praxis
```

**Step 5: Verify toolchain**
Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean (no src yet), vitest "no test files found" (exit 0 or documented).

**Step 6: Commit**
```bash
git add -A && git commit -m "chore: scaffold praxis (ts + vitest + sqlite + mcp)"
```

---

## Task 1 (U1): Skill model + SQLite store

**Files:**
- Create: `src/skill.ts` (types), `src/store.ts` (SQLite store), `src/store.test.ts`

**Step 1: Write failing test (`src/store.test.ts`)**
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SkillStore } from './store.js'
import type { Skill } from './skill.js'

const mk = (over: Partial<Skill> = {}): Skill => ({
  id: '', name: 'reverse', interface: '(s:string)->string',
  implementation: 'return input.split("").reverse().join("")',
  acceptanceTest: 'assert(run("ab")==="ba")', capabilities: [], cost: 'cheap',
  provenance: { task: 'reverse a string', model: 'test', parents: [], createdAt: 0, evidence: '' },
  embedding: [0.1, 0.2], utilityScore: 0, status: 'quarantined', version: 1, ...over,
})

describe('SkillStore', () => {
  let store: SkillStore
  beforeEach(() => { store = new SkillStore(':memory:') })

  it('insert returns id and round-trips', () => {
    const id = store.insert(mk())
    expect(id).toBeTruthy()
    const got = store.get(id)
    expect(got?.name).toBe('reverse')
    expect(got?.status).toBe('quarantined')
  })

  it('updateStatus transitions verified', () => {
    const id = store.insert(mk())
    store.updateStatus(id, 'verified')
    expect(store.get(id)?.status).toBe('verified')
  })

  it('listByStatus filters', () => {
    const a = store.insert(mk({ name: 'a' })); store.updateStatus(a, 'verified')
    store.insert(mk({ name: 'b' }))
    expect(store.listByStatus('verified').map(s => s.name)).toEqual(['a'])
  })
})
```

**Step 2: Run - expect FAIL** (`npx vitest run src/store.test.ts`) - "Cannot find module './store.js'".

**Step 3: Implement `src/skill.ts`**
```ts
export type SkillStatus = 'quarantined' | 'verified' | 'refuted' | 'archived'
export interface Provenance { task: string; model: string; parents: string[]; createdAt: number; evidence: string }
export interface Skill {
  id: string; name: string; interface: string; implementation: string;
  acceptanceTest: string; capabilities: string[]; cost: 'cheap' | 'normal' | 'expensive';
  provenance: Provenance; embedding: number[]; utilityScore: number;
  status: SkillStatus; version: number;
}
```

**Step 4: Implement `src/store.ts`** (better-sqlite3; JSON-encode arrays/objects; generate id via crypto.randomUUID). Methods: `insert(skill)`, `get(id)`, `updateStatus(id,status)`, `update(skill)`, `listByStatus(status)`, `all()`, `delete(id)`. Schema columns mirror Skill fields; embeddings/capabilities/provenance stored as JSON text.

**Step 5: Run - expect PASS.** Capture output.

**Step 6: Commit** `feat(store): skill model + sqlite store`

---

## Task 2 (U2): Sandbox runner + verify gate  [TRUST-CRITICAL]

**Files:**
- Create: `src/sandbox.ts`, `src/verify.ts`, `src/verify.test.ts`, `src/sandbox-worker.ts`

**Invariant (property test):** no input path promotes a skill to `verified` unless its acceptance test actually executed and passed. Fail-closed on timeout/crash.

**Step 1: Failing tests (`src/verify.test.ts`)**
```ts
import { describe, it, expect } from 'vitest'
import { verifySkill } from './verify.js'
import type { Skill } from './skill.js'

const base = (impl: string, test: string): Skill => ({
  id: 'x', name: 't', interface: '(n:number)->number', implementation: impl,
  acceptanceTest: test, capabilities: [], cost: 'cheap',
  provenance: { task: '', model: '', parents: [], createdAt: 0, evidence: '' },
  embedding: [], utilityScore: 0, status: 'quarantined', version: 1,
})

describe('verifySkill (fail-closed)', () => {
  it('passes when acceptance holds', async () => {
    const r = await verifySkill(base('return input * 2', 'assert(run(3) === 6)'))
    expect(r.status).toBe('verified')
  })
  it('rejects when acceptance fails', async () => {
    const r = await verifySkill(base('return input * 2', 'assert(run(3) === 7)'))
    expect(r.status).toBe('refuted')
  })
  it('quarantines on timeout (infinite loop)', async () => {
    const r = await verifySkill(base('while(true){}', 'assert(run(1)===1)'), { timeoutMs: 500 })
    expect(r.status).toBe('quarantined')
    expect(r.reason).toMatch(/timeout/i)
  })
  it('quarantines on thrown error', async () => {
    const r = await verifySkill(base('throw new Error("boom")', 'assert(run(1)===1)'))
    expect(r.status).toBe('quarantined')
  })
  it('never verifies without an acceptance test', async () => {
    const r = await verifySkill(base('return 1', ''))
    expect(r.status).not.toBe('verified')
  })
})
```

**Step 2: Run - expect FAIL.**

**Step 3: Implement sandbox** (`src/sandbox-worker.ts` runs in a worker_thread): receives `{implementation, acceptanceTest}`, builds `run = new Function('input', implementation)` and an `assert` helper, executes the acceptance test, posts `{ok:true}` or `{ok:false,error}`. No `fs`/`net`/`process` passed in. `src/sandbox.ts` spawns the worker with a hard timeout; on timeout terminate worker and return `timeout`.

**Step 4: Implement `verifySkill`**: empty test -> quarantined; run sandbox; pass -> verified; assertion-fail -> refuted; timeout/throw -> quarantined with reason. Returns `{ status, reason }`.

**Step 5: Run - expect PASS.** Capture output (this is the trust-critical proof).

**Step 6: Commit** `feat(verify): sandboxed verify-before-keep gate (fail-closed)`

> Honest caveat to record in code comments: worker_threads + timeout + no-injection is v1 isolation, NOT a hardened multi-tenant sandbox. Harden (vm2 successor / isolated-vm / subprocess + seccomp) before running untrusted third-party skills in a hosted tier.

---

## Task 3 (U3): Capture (task -> skill candidate)

**Files:** `src/capture.ts`, `src/capture.test.ts`

A `SkillCandidate` builder: given `{ name, interface, implementation, acceptanceTest, provenance }`, returns a `Skill` with `status='quarantined'`, `version=1`, empty embedding (filled in U4), `utilityScore=0`. Pure/deterministic - easy TDD. Test: builds a well-formed quarantined skill; rejects missing name/implementation.

Commit: `feat(capture): build skill candidates from solved tasks`

---

## Task 4 (U4): Embedder + dedup/merge on write

**Files:** `src/embedder.ts` (interface + HashingEmbedder + TransformersEmbedder), `src/dedup.ts`, `src/dedup.test.ts`

**Embedder interface:** `embed(text: string): Promise<number[]>`. `HashingEmbedder` = deterministic bag-of-token hash -> fixed-dim vector (no network; used in tests). `TransformersEmbedder` = @xenova/transformers all-MiniLM-L6-v2 (prod).

**Dedup logic (`maybeMerge(store, candidate, embedder, threshold=0.92)`):**
- embed candidate (name + interface + task)
- cosine vs existing verified+quarantined skills
- if max cosine >= threshold AND interface compatible -> reinforce existing (bump utility, do NOT insert); return `{action:'reinforced', id}`
- else insert; return `{action:'inserted', id}`

**Tests (HashingEmbedder, deterministic):**
- two near-identical candidates -> second is `reinforced`, store count stays 1
- two unrelated candidates -> both `inserted`, count 2

Commit: `feat(dedup): embedding+interface dedup/merge on write`

---

## Task 5 (U5): Budgeted top-k retrieval  [KEY COST DECOUPLING]

**Files:** `src/retrieve.ts`, `src/retrieve.test.ts`

`recall(store, embedder, query, { k=5, tokenBudget })`: embed query, cosine over verified skills, rank by `cosine * statusWeight * recencyDecay * utilityBoost`, take top-k, then trim to fit `tokenBudget` (estimate tokens per skill). Returns the selected skills + `costEstimate`.

**Tests:**
- returns at most k
- **per-call cost is bounded regardless of library size**: insert 50 vs 5000 verified skills; assert `recall(...).costEstimate` is within the same bound and `selected.length <= k` in both. (This is the headline guarantee - test it explicitly.)
- higher-utility skill outranks equal-cosine lower-utility skill

Commit: `feat(retrieve): budgeted top-k recall; per-call cost independent of size`

---

## Task 6 (U6): run_skill + composition

**Files:** `src/run.ts`, `src/run.test.ts`

`runSkill(store, id, input)`: load skill, execute in sandbox, return result. Composition: a skill whose `implementation` references `call('<skillName>', x)` resolves sub-skill calls through the store (only `verified` sub-skills callable). A composed skill has its own acceptance test and must pass verify (U2) like any other.

**Tests:**
- run a leaf skill returns expected output
- a composed skill that calls two verified leaf skills produces the composed result
- composition referencing a non-verified sub-skill is rejected

Commit: `feat(run): execute + compose verified skills by reference`

---

## Task 7 (U7): Utility scoring + eviction + tiered hot/cold

**Files:** `src/utility.ts`, `src/tier.ts`, `src/tier.test.ts`

- `utilityScore = w1*log(1+uses) + w2*successRate + w3*recency + w4*generality`
- `reinforce(store, id, outcome)`: update uses/successRate, recompute score
- Tiering: `hot` = top-N verified by utility (N is the cap); below -> `archived` (cold). `promote/demote` on score change.

**Tests:**
- hot-set never exceeds cap N (insert N+10 verified, assert hot count == N)
- a skill that fails its check post-hoc is demoted/quarantined (anti-regression)
- reinforce raises score and can promote a cold skill

Commit: `feat(tier): utility scoring, bounded hot set, eviction, anti-regression`

---

## Task 8 (U8): Negative skills (negative memory)

**Files:** `src/negative.ts`, `src/negative.test.ts`

`recordFailure(store, { task, approach, reason })` stores a `kind=failure` entry. `recall` (U5) also surfaces top relevant negatives for a query. Test: after recording a failure for approach X, a recall for a similar task includes the negative with its reason.

Commit: `feat(negative): first-class negative skills surfaced before retry`

---

## Task 9 (U9): MCP server

**Files:** `src/mcp.ts`, `src/mcp.test.ts`, bin entry in `package.json`

Expose tools via @modelcontextprotocol/sdk: `remember_skill` (capture->verify->dedup->store), `recall_skills` (budgeted retrieval, incl. negatives), `run_skill`, `record_failure`, `reinforce`, `library_stats`. Each tool returns a valid MCP content envelope.

**Tests:** call each tool handler directly (unit-level, not over stdio); assert valid result shape and that `remember_skill` of a failing-acceptance skill returns `status: refuted/quarantined` (never verified). Add a manual stdio smoke step documented for Claude Code/Cursor wiring.

Commit: `feat(mcp): server exposing the praxis skill-library tools`

---

## Task 10 (U10): Consolidation CLI

**Files:** `src/consolidate.ts`, `src/cli.ts`, `src/consolidate.test.ts`

`consolidate(store, embedder)`: run dedup/merge across the whole library, evict cold low-utility, (v1) flag overlapping clusters for generalization. `cli.ts` exposes `praxis consolidate`, `praxis stats`. Test: a library with injected duplicates shrinks after consolidate; counts reported.

Commit: `feat(consolidate): scheduled compaction pass + CLI`

---

## Task 11 (U11): Proof benchmark + library_stats view

**Files:** `bench/praxis-bench.ts`, `bench/README.md`, `src/stats.ts`

`praxis-bench`: a fixed task stream; per step record (a) verified-skill count, (b) tasks solved that were previously unsolved (capability growth), (c) library size vs tasks (assert sublinear), (d) per-task retrieval cost (assert flat), (e) repeat-error rate with negatives ON vs OFF. Emit a JSON + a simple chart-ready CSV. `library_stats`/`stats.ts` renders the capability view (the lovable, screenshot-able surface).

**Acceptance for the whole build:** bench shows capability growth up-and-to-the-right, library size sublinear, per-task cost flat, repeat-error lower with negatives ON. Tag all synthetic clearly.

Commit: `feat(bench): proof benchmark + capability stats view`

---

## After the build (separate gates, per global doctrine)
- `npx tsc --noEmit` + full `npx vitest run` GREEN with captured output
- generalization-probe on the verify gate + retrieval budget
- code-reviewer, then production-certifier
- Only then: public README, naming finalize, npm publish, launch post

## Non-negotiables
- DRY, YAGNI, TDD, frequent commits.
- The verify gate (U2) is trust-critical: keep its property test green at all times.
- No "done" without captured test output. Decompose; verify each unit before integrating.
