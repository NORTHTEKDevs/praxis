# Praxis - Design Doc

- Date: 2026-06-23
- Status: APPROVED (concept + cost-control approved by Kristian; "build it")
- Owner: Kristian Baer / Northtek
- Working name: Praxis (skill-through-practice). Rename-able.

## 1. Problem & thesis

LLM agents do not durably improve. Every session starts from zero competence on
your specific work; nothing learned in session N is reliably available in session
N+1, and what little is carried (raw memory/context) is unverified and decays into
noise (context rot). The agentic-research frontier (mid-2026) confirms reliability +
verifiable accumulation as the #1 open theme.

Thesis: an agent should accumulate **verified, composable abilities** - not fuzzy
memories - so it gets measurably and durably better at your work over time, and never
silently regresses. This is capability accumulation, a different category from a
memory layer.

## 2. What it is

Praxis is an engine + MCP server that lets any agent build a **self-pruning, verified,
composable skill library**. The agent solves a task once, distills it into a named
skill with a checkable acceptance test, and Praxis keeps that skill ONLY if it passes
verification. Kept skills compose like functions, carry provenance, and the library
stays lean by design.

Positioning:
- vs Voyager (NeurIPS 2023 skill library): Voyager's skills were unverified LLM code
  that broke and did not reliably compose. Praxis's differentiator is verified +
  composable + provenance-tracked + non-regressing + bounded-cost.
- vs mem0 / Letta / Zep (memory layers): they store facts you have seen and recall by
  similarity. Praxis stores abilities you have proven and composes them. Memory is a
  notebook; Praxis is accumulated expertise.

## 3. Core concepts

Skill (the unit):
```
Skill {
  id
  name                 // human + machine handle
  interface            // typed signature: inputs -> outputs
  implementation       // executable body (code) OR a composed plan of sub-skill calls
  acceptance_test      // the deterministic check that defines "this works"
  capabilities         // declared side effects / permissions (Kryos-style)
  cost                 // declared/measured cost class
  provenance           // origin task, parent skills, model, timestamp, evidence
  embedding            // for similarity / retrieval
  utility_score        // f(uses, success_rate, recency, generality)
  status               // verified | quarantined | refuted | archived
  version              // monotonic; supports anti-regression
}
```

Verify-before-keep: a candidate skill is run against its acceptance_test in a sandbox.
Pass -> verified. Fail / no test / sandbox error -> quarantined or rejected. Nothing
is promoted to verified on the agent's say-so (the doctrine: self-report is not
evidence).

Composition: a skill's implementation may be a plan that calls other verified skills
by reference. Composition is itself verified (the composed skill has its own
acceptance test). This is where exact, reliable composition matters.

Negative skill (negative memory, as a first-class unit): a recorded "this approach
fails for this class, because Y" - retrieved BEFORE the agent retries a known wall.

## 4. Architecture / components

```
+------------------+        +-------------------+        +------------------+
|  Capture          |  -->   |  Verify gate       |  -->  |  Library store    |
|  (task -> skill    |        |  (sandbox runner   |       |  (tiered: hot/    |
|   candidate)       |        |   + acceptance)    |       |   warm/cold)      |
+------------------+        +-------------------+        +------------------+
                                                              |   ^
                            +-------------------+             v   |
   agent  <--- tools <----  |  Retrieval         | <-----  Dedup/Merge/Generalize
                            |  (budgeted top-k)   |             |
                            +-------------------+             v
                                                        Consolidation pass
                                                        (evict / compress)
                            +-------------------+
   outcome  ---------->     |  Reinforcement     |  --> utility_score update
                            +-------------------+
```

Components:
- Capture: turns a solved task into a skill candidate (name, interface, implementation,
  drafted acceptance test).
- Verify gate: sandboxed execution of the acceptance test; fail-closed.
- Dedup/Merge/Generalize: similarity (embedding + interface) check before insert;
  reinforce/merge near-duplicates; distill overlapping specific skills into one
  parameterized general skill.
- Library store: tiered storage (hot working set bounded; warm on-disk; cold archive).
- Retrieval: budgeted top-k relevant verified skills + relevant negative skills,
  exposed as callable tools.
- Reinforcement: post-outcome utility update (was_false / success signal).
- Consolidation: scheduled compaction (dedup, generalize, evict).

## 5. Cost & bloat control (the centerpiece requirement)

The library is self-pruning and self-generalizing, NOT append-only.

1. Verify-gate at entry: failed attempts never become skills (no garbage at source).
2. Dedup + merge on write: near-match -> reinforce/merge instead of duplicate.
3. Generalize/compress: N overlapping specific skills -> 1 parameterized skill; library
   trends toward fewer, more general skills.
4. Utility-weighted eviction + tiered storage: cold/low-utility skills archived; hard
   cap on the hot set.
5. Budgeted top-k retrieval (KEY cost decoupling): agent never loads the whole library;
   retrieves top-k within a token/cost budget and calls skills by reference. Per-task
   cost is O(k), INDEPENDENT of total library size. A 10k-skill library costs the same
   per call as a 50-skill one.
6. Per-skill cost accounting + periodic consolidation: each skill declares cost/
   capabilities; background compaction keeps the library lean.

Net guarantee: library grows SUBLINEARLY (dedup+generalize fight growth), and per-task
cost is BOUNDED by the retrieval budget regardless of size.

## 6. Surfaces

- MCP server (primary): tools = remember_skill, recall_skills, run_skill,
  record_failure, reinforce, library_stats. Instant compatibility with Claude Code,
  Cursor, any MCP client (broad reach, no per-framework adapters).
- Programmatic API (TS) for embedded use.
- Hosted REST tier later (deferred).

## 7. Storage

- Local default: SQLite + vector extension (sqlite-vec). Zero-config.
- Hosted tier (later): Postgres + pgvector (Neon, already available).
- Pluggable store interface so local -> hosted is a swap.

## 8. Data flow

capture -> verify (sandbox) -> dedup/merge/generalize -> store (tiered)
retrieve (budgeted top-k) -> compose/run -> outcome -> reinforce -> (scheduled) consolidate

## 9. Failure modes (fail-closed by default)

- Verifier crash/timeout -> quarantine, never verify.
- Sandbox escape attempt / disallowed capability -> reject + flag.
- Storage down -> degrade to in-memory hot set + warn.
- Skill that later fails its acceptance -> auto-quarantine (anti-regression).
- Over-retrieval -> hard budget cap.

## 10. Stack decisions

- Language/core: TypeScript. Ships as an MCP server + TS library. Matches npm/Vercel/
  Neon pipeline. (Alt: Python-native core for direct LangGraph/CrewAI embedding -
  switch if ecosystem-native embedding outranks ship speed.)
- Storage: SQLite + sqlite-vec local; Postgres+pgvector hosted.
- Sandbox: out-of-process execution with a capability allowlist + timeout (exact
  mechanism chosen in plan; must be safe for arbitrary skill code).

## 11. MVP scope (YAGNI)

In:
- Skill data model + SQLite store (tiered hot/cold minimal).
- Capture -> verify gate (sandboxed acceptance test) -> store.
- Dedup/merge on write (embedding + interface similarity).
- Budgeted top-k retrieval exposed as MCP tools; run_skill by reference.
- Composition (a skill that calls verified sub-skills).
- Utility scoring + eviction (cold archive + hot cap).
- Negative skills (record_failure + surfaced in retrieval).
- library_stats (the skill-tree / capability view = the lovable demo surface).
- Consolidation as a CLI command (scheduling later).
- A small proof benchmark (accumulation + bounded cost + improvement).

Out (later): generalize/compress automation (start manual/heuristic), hosted REST +
multi-tenant auth, dashboard UI, Python client, advanced RAPTOR-style skill index.

## 12. Decomposition into independently-verifiable units

Each unit ships with captured test output before integration (agents collapse past
~20 files/600 lines; decompose).

- U1: Skill model + SQLite store + migrations. Tests: CRUD, status transitions.
- U2: Sandbox runner + verify gate (fail-closed). Tests: pass/fail/timeout/escape;
      property test: no path promotes an unverified skill to verified.
- U3: Capture (task -> skill candidate + drafted acceptance test).
- U4: Embedding + dedup/merge on write. Tests: near-duplicate reinforced not added.
- U5: Budgeted top-k retrieval. Tests: per-call cost bounded; relevance ranking.
- U6: run_skill + composition (call verified sub-skills). Tests: composed acceptance.
- U7: Utility scoring + eviction + tiered hot/cold. Tests: hot-set cap holds; cold
      archive/restore.
- U8: Negative skills (record_failure + retrieval surfacing).
- U9: MCP server wiring all tools. Tests: tools/call returns valid envelopes.
- U10: Consolidation CLI (dedup/generalize/evict pass).
- U11: Proof benchmark + library_stats view.

## 13. Testing strategy

- TDD (red-green) per unit; capture command output as evidence (no self-reported pass).
- Property tests on the verify gate (the trust-critical invariant).
- A poisoning/red-team suite: attempt to inject a skill that claims-but-fails; assert it
  never reaches verified.
- The benchmark doubles as an integration test.

## 14. Proof artifact (credibility lever)

praxis-bench: on a fixed task stream, measure (a) capability growth (verified skills
that solve previously-unsolved tasks), (b) library size vs tasks processed (must grow
sublinearly), (c) per-task retrieval cost (must stay flat as library grows), (d)
repeat-error rate with negative skills on/off. The "ON beats OFF" + "stays lean" curves
are the public, screenshot-able result.

## 15. Risks / open questions

- Composition reliability: making skills genuinely compose (not just stack) is the hard
  research-grade part. Mitigation: composed skills have their own acceptance tests;
  start with shallow composition, deepen with evidence.
- Acceptance-test quality: a skill is only as trustworthy as its check. Mitigation:
  require a check; score skills by check strength; quarantine weak-check skills.
- Sandbox safety for arbitrary skill code: must be genuinely isolated. Mitigation:
  out-of-process + capability allowlist + timeout; no network by default.
- Honest scope: do NOT claim general self-improvement. Claim: durable, verified,
  bounded-cost capability accumulation on the user's workflows.

## 16. Non-goals / overclaim guardrails

- Not "an agent that becomes generally smarter." It accumulates verified skills in
  whatever domains it is used.
- Not a replacement for the LLM. The LLM proposes; Praxis verifies, keeps, composes.
- Benchmarks are tagged honestly; no synthetic result presented as real-world general.
