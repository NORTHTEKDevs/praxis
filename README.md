# Praxis

**Give your AI assistant a memory for the things it has *proven* it can do.**

AI assistants are forgetful. Every new conversation, your assistant starts from scratch - it doesn't remember the tricky thing it figured out yesterday, so it works it out all over again (and sometimes gets it wrong all over again).

Praxis fixes that, with a twist most "AI memory" tools miss: **it only saves a skill after the AI has actually run it and shown it works.** No guessing, no "I'm pretty sure this is right." If it doesn't pass the check, it doesn't get saved.

Think of the difference between:

- **A notebook of ideas** (what normal AI memory does): *"I think the way to do this is..."* - might be wrong.
- **A box of tested recipes** (what Praxis does): *"Here's exactly how to do this - I've made it before, it works."*

> Memory stores what you *saw*. Praxis stores what you *proved*.

## What it does, in plain terms

- **Remembers real skills, not guesses.** When your AI solves a task, Praxis keeps it only if it passes a real, automatic check. Failed attempts never get saved as "knowledge."
- **Remembers mistakes too.** It keeps a short list of things that *didn't* work, so your AI sees "you already tried this and it failed" *before* it wastes time repeating it.
- **Stays small and fast.** It doesn't pile up forever. Near-duplicates get merged, and skills that never get used get cleaned out automatically - so it won't get slow or expensive as it grows.
- **Reuses and combines skills.** Once a skill is proven, your AI can use it again instantly, or snap several proven skills together to do something bigger.
- **Works with the AI tools you already use** - Claude Code, Cursor, or your own agent. Anything that speaks **MCP** (a common standard for plugging tools into AI assistants).

## Why you'd want it

- Your AI gets **more dependable over time on your actual work**, instead of resetting to zero every session.
- It **stops repeating the same mistakes.**
- It **won't balloon** into something slow or costly - it tidies up after itself.
- It's **honest**: a saved skill is something that genuinely ran and passed, not something the AI merely felt confident about.

One honest caveat: Praxis makes your assistant *more reliable*, not *smarter*. The AI still does the thinking - Praxis is the part that double-checks the work and remembers only the wins.

---

## For developers

Praxis is a small, dependency-light **MCP server**. Core and tests use **Node 24 built-ins only** (`node:sqlite`, `node:test`, native TypeScript type-stripping) - no build step for development. The published npm package ships precompiled plain JS (`tsc` at pack time only - Node refuses type-stripping under `node_modules`). The only runtime dependency is the MCP SDK.

### Install

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

### How it works

```
solve a task -> distill a Skill {interface, implementation, acceptanceTest}
            -> VERIFY in a sandbox (pass => kept, fail/timeout/async => quarantined)
            -> dedup/merge on write
            -> recall top-k within a token budget (+ known failures)
            -> compose verified skills by reference
            -> score by utility, evict/consolidate to stay lean
```

The agent stays the brain; Praxis is the part that only keeps what's proven.

### Tools (MCP)

`remember_skill` · `recall_skills` · `run_skill` · `record_failure` · `reinforce` · `library_stats` · `pin_skill` · `sync_skills` · `consolidate_now`

`recall_skills` returns verified skills **and** relevant negative skills ("known failure modes") so the agent sees the wall it hit last time *before* it retries.

### From proven skill to Claude Code skill

`praxis sync` (also the `sync_skills` MCP tool) compiles your verified hot skills into real Claude Code skill directories:

```bash
praxis sync                 # -> ./.claude/skills/praxis-<name>/SKILL.md + impl.mjs
praxis sync --global        # -> ~/.claude/skills/
praxis sync --prune         # remove stale exports instead of marking them
```

Each exported skill carries its interface, the proven implementation, and the acceptance test it passed. The honesty guarantee travels with it: **no exported skill outlives its proof.** If a skill is later quarantined (a `reinforce` failure re-ran its test and it broke), demoted out of the hot tier, or evicted, the next sync rewrites its SKILL.md as `[STALE - failed re-verify]` (or removes it with `--prune`). Sync is idempotent, tracked by a manifest, and never touches skill files it didn't write.

**Optional flywheel loop:** if [claude-code-flywheel](https://github.com/NORTHTEKDevs/claude-code-flywheel)'s Work Ledger is present (`~/.claude/state/ledger.jsonl` or `FLYWHEEL_LEDGER`), sync first ingests `praxis-*` skill firings as *usage* signal - feeding generality/utility scoring, so skills you actually use stay hot and skills you don't decay out. Fire events carry no outcome, so they are recorded as retrievals, never as fabricated successes. No flywheel installed: sync works identically minus the usage signal. Praxis reads the ledger file format only - there is no dependency between the projects.

### What keeps it from bloating / getting expensive

The library is self-pruning, not append-only:

1. **Verify gate at entry** - failed attempts never become skills.
2. **Dedup + merge on write** - a near-duplicate reinforces the existing skill instead of adding one.
3. **Utility-weighted tiering** with a bounded hot set; warm/cold skills are excluded from recall but stay callable by id (and can be promoted back by consolidation).
4. **Budgeted top-k retrieval** - context cost is **O(k) tokens, bounded by `tokenBudget`, independent of library size**. (Retrieval *compute* is O(hot-set size), bounded by the hot-set cap - not O(1).)
5. **Consolidation pass** - regression-safe dedup-merge + eviction.

### Trust

The verify gate is fail-closed: a skill reaches `verified` only if its acceptance test executed and passed. The sandbox runs in a worker thread with a hard memory cap and a timeout kill, and defends against `try/catch` assert-swallowing, async vacuous-passes, weak self-referential tests, and tests that try to detect or tamper with the checker. It is **isolated with a memory cap and timeout kill - not a hardened multi-tenant security boundary** (run only your own agent's code in v1; hosted/untrusted-code use needs `isolated-vm` or a subprocess sandbox).

### Benchmark

See [`bench/`](bench/). The benchmark is **synthetic** (an author-designed task stream, `HashingEmbedder`); it is an existence proof that the system behaves as designed - capability reuse, sublinear growth on repeated work (the long tail grows linearly, and is shown), bounded per-task cost, and a measured repeat-error reduction with negatives on. Not a general-performance claim.

### Honest scope (what Praxis does NOT claim)

- Not "your agent becomes smarter" - it **accumulates verified expertise on your workflows.** The LLM proposes; Praxis verifies and keeps.
- Not "the first verified skill library" - prior art (Voyager, SkillGen, PreAct) verifies too. The specific unclaimed combination: a **domain-agnostic, sandboxed, fail-closed acceptance gate + first-class negative skills + budgeted O(k)-context retrieval, exposed via MCP.**
- Composed skills carry their own acceptance tests and cascade-quarantine when a sub-skill is invalidated; deep arbitrary-graph reliability is not guaranteed in v1.
- Library growth is **architected** for sublinearity via dedup/merge/eviction; it is not a guarantee for all workloads.

### Prior art

Voyager (2305.16291), Reflexion (2303.11366), SkillGen (2408.08435), PreAct (2606.17929), Generative Agents (2304.03442), SoK: Agentic Skills (2602.20867). Praxis builds on the verify-before-keep idea and adds first-class negative skills + budgeted retrieval + an MCP surface.

## License

MIT - see [LICENSE](LICENSE).
