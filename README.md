# Praxis

**Verified skill accumulation for AI agents.** Your agent proves it can do something, then remembers that it can.

Every session, your AI agent starts from zero competence on your specific work. Memory layers give it notes. Praxis gives it **verified abilities**: when your agent solves a task, Praxis distills it into a named skill with a checkable acceptance test, and keeps it **only if it passes in a sandbox** - no LLM say-so, no garbage in. The library is self-pruning, and per-task context cost is bounded regardless of how large it grows.

Praxis is **not a memory layer.** Memory systems promote what the model decided was worth remembering (LLM salience). Praxis promotes what actually ran and passed (deterministic execution). A verified Praxis skill is a falsifiable claim, not a confident belief. **Memory stores what you saw; Praxis stores what you proved.**

Works with any MCP client - Claude Code, Cursor, or your own agent.

## Install

Requires Node 24+.

```bash
npm i -g @northtek/praxis
praxis init
```

`praxis init` runs a self-test and prints the stanza to add to your `.mcp.json`:

```json
{ "mcpServers": { "praxis": { "command": "praxis", "args": ["serve"] } } }
```

Restart your agent. Done.

## How it works

```
solve a task -> distill a Skill {interface, implementation, acceptanceTest}
            -> VERIFY in a sandbox (pass => kept, fail/timeout/async => quarantined)
            -> dedup/merge on write
            -> recall top-k within a token budget (+ known failures)
            -> compose verified skills by reference
            -> score by utility, evict/consolidate to stay lean
```

The agent stays the brain; Praxis is the part that only keeps what's proven.

## Tools (MCP)

`remember_skill` · `recall_skills` · `run_skill` · `record_failure` · `reinforce` · `library_stats` · `pin_skill` · `consolidate_now`

`recall_skills` returns verified skills **and** relevant negative skills ("known failure modes") so the agent sees the wall it hit last time *before* it retries.

## What keeps it from bloating / getting expensive

The library is self-pruning, not append-only:

1. **Verify gate at entry** - failed attempts never become skills.
2. **Dedup + merge on write** - a near-duplicate reinforces the existing skill instead of adding one.
3. **Utility-weighted tiering** with a bounded hot set; warm/cold skills are excluded from recall but stay callable by id (and can be promoted back by consolidation).
4. **Budgeted top-k retrieval** - context-cost is **O(k) tokens, bounded by `tokenBudget`, independent of library size**. (Retrieval *compute* is O(hot-set size), bounded by the hot-set cap - not O(1).)
5. **Consolidation pass** - regression-safe dedup-merge + eviction.

## Trust

The verify gate is fail-closed: a skill reaches `verified` only if its acceptance test executed and passed. The sandbox runs in a worker thread with a hard memory cap and a timeout kill, and defends against `try/catch` assert-swallowing, async vacuous-passes, and weak self-referential tests. It is **isolated with a memory cap and timeout kill - not a hardened multi-tenant security boundary** (run only your own agent's code in v1; hosted/untrusted-code use needs `isolated-vm` or a subprocess sandbox).

## Benchmark

See [`bench/`](bench/). The benchmark is **synthetic** (an author-designed task stream, `HashingEmbedder`); it is an existence proof that the system behaves as designed - capability reuse, sublinear growth on repeated work (the long tail grows linearly, and is shown), bounded per-task cost, and a measured repeat-error reduction with negatives on. Not a general-performance claim.

## Honest scope (what Praxis does NOT claim)

- Not "your agent becomes smarter" - it **accumulates verified expertise on your workflows.** The LLM proposes; Praxis verifies and keeps.
- Not "the first verified skill library" - prior art (Voyager, SkillGen, PreAct) verifies too. The specific unclaimed combination: a **domain-agnostic, sandboxed, fail-closed acceptance gate + first-class negative skills + budgeted O(k)-context retrieval, exposed via MCP.**
- Composition: composed skills carry their own acceptance tests and cascade-quarantine when a sub-skill is invalidated; deep arbitrary-graph reliability is not guaranteed in v1.
- Library growth is **architected** for sublinearity via dedup/merge/eviction; it is not a guarantee for all workloads.

## Prior art

Voyager (2305.16291), Reflexion (2303.11366), SkillGen (2408.08435), PreAct (2606.17929), Generative Agents (2304.03442), SoK: Agentic Skills (2602.20867). Praxis builds on the verify-before-keep idea and adds first-class negative skills + budgeted retrieval + an MCP surface.

## License

MIT.
