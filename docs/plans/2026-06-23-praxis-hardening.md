# Praxis Hardening Package (from ultracode workflow, 10 agents / 618K tokens)

- Date: 2026-06-23
- Source: workflow praxis-hardening (wf_fea6e055-bc2). Full raw output in the run's task output file.
- Verdict: readyToBuild = FALSE until the CRITICAL gaps below are closed.

## Positioning (validated against real prior art)

- Name: **Praxis** (keep). npm: `@northtek/praxis`.
- One-liner: "Verified skill accumulation for AI agents. Your agent proves it can do something, then remembers that it can."
- Differentiator (the load-bearing sentence): **"memory stores what you saw; Praxis stores what you proved."** Memory systems promote on LLM salience; Praxis promotes on deterministic code-execution outcome. A verified skill is a falsifiable claim, not a confident belief.

### 3 novelty claims that survive scrutiny (the unclaimed combination)
1. Domain-agnostic, sandboxed, **fail-closed** acceptance gate as a universal entry gate to a persistent skill library, exposed via MCP. (Voyager: in-env self-verify, not sandboxed/fail-closed. SkillGen: offline batch. PreAct: UI-domain-specific. None domain-agnostic + MCP + fail-closed.)
2. **Budgeted O(k)-context retrieval** as a first-class API contract (`tokenBudget` param). Context-cost O(k) tokens independent of library size.
3. **First-class negative skills**, retrieved proactively before retry. No surveyed system has this as a typed library artifact. (Lineage: founder's cognitive-kernel negative memory.)

### Must-cite prior art (acknowledge, don't hide)
Voyager (2305.16291), Reflexion (2303.11366), ExpeL (2308.10144), Generative Agents (2304.03442), SkillGen (2408.08435), PreAct (2606.17929), HASP (2605.17734), SoK Agentic Skills (2602.20867), SkillOps (2605.13716), DreamCoder, LILO (2310.19791), isolated-vm, CVE-2025-68613 / CVE-2026-1470 (why not node:vm).

### Overclaim guardrails (do NOT say)
- NOT "O(k) per-task cost independent of size" unqualified -> say context-cost O(k); compute-cost O(hot_set_size) bounded by the hot-set cap (needs U7).
- NOT "first verified skill library" -> SkillGen/PreAct verify too. Say "first domain-agnostic, sandboxed, fail-closed, MCP-exposed skill library with first-class negative skills."
- NOT "grows sublinearly" as a guarantee -> "architected for sublinear growth via dedup+merge+eviction; long-tail unique tasks grow linearly (shown)."
- NOT "reliable composition" -> "composed skills carry their own acceptance tests + cascade-quarantine on sub-skill demotion; deep arbitrary-graph reliability not guaranteed in v1."
- NOT "secure sandbox" -> "isolated with a hard memory cap and timeout kill; not a multi-tenant boundary in v1."
- NOT "your agent becomes smarter / self-improves" -> "accumulates verified expertise on your workflows."
- Every benchmark chart labeled `[synthetic task stream, n=60, HashingEmbedder]`.

## Hardening delta (mapped to units)

### CRITICAL (fix in already-built units)
- U2 sandbox: replace main-process node:vm with a Worker running the eval; `resourceLimits.maxOldGenerationSizeMb=64`; host-side setTimeout -> `worker.terminate()`. Closes OOM-kills-host. Comment: "isolated with hard memory cap + timeout kill", NOT "secure". v1.1 upgrade: isolated-vm.
- U2 verify: async/Promise detection - if `run(input)` returns a thenable, throw "async skill rejected"; else assert(Promise) passes vacuously -> false verify.
- U2 verify: min acceptance-test strength - require >=1 concrete expected-value literal; reject `assert(true)` / `assert(run(x)===run(x))` -> quarantined "acceptance test too weak". Check BEFORE running sandbox. Store `checkStrength`.
- U4 dedup: reinforce utility ONLY on `status='verified'` matches. Keep quarantined in the dedup-detection scan (avoid re-insert) but never bump their utility.
- U1 store: `PRAGMA journal_mode=WAL; synchronous=NORMAL; busy_timeout=5000`; `CHECK(status IN (...))`; schema_version + migrations.

### HIGH
- embedder: `cosine` returns 0 on dimension mismatch (no silent truncate). Add `embedderVersion` column; refuse cross-version dedup.
- schema: add `kind` ('positive'|'negative'), `tier` ('hot'|'warm'|'cold'), `uses`, `successRate`, `pinned`, `checkStrength` columns NOW (before U5) + `skill_deps(skill_id,dep_id)` + `skill_retrievals(skill_id,task,retrieved_at)` tables + CHECK constraints. Avoids mid-project breaking migration.
- adversarial verify suite (`verify-adversarial.test.ts`): assert-swallowing try/catch, run-redefinition, allocation bomb hits 64MB cap, 100 rapid calls no worker leak.
- U6 composition: inject `call` resolver into sandbox; pre-resolve sub-skill names to verified IDs; validate exist+verified+no-cycle(DFS over skill_deps)+no-capability-escalation; reject at validation time (CompositionError), not timeout. Cascade quarantine on sub-skill demotion.
- U9 MCP: rate-limit remember_skill 60/min; semaphore max 4 workers; `wrapTool()` error envelope; `praxis init` (creates .praxis, self-test, prints .mcp.json stanza). `.claude/mcp-example.json`.

### MEDIUM/LOW
- U10: BEGIN EXCLUSIVE mutex; MDL merge acceptance (|G| < |S1|+|S2| AND G passes its own + S1 + S2 acceptance tests); >=3 instances before merge; `autoConsolidateAfterN` (100); `praxis reindex`.
- U7 weights (explicit): score = 0.3*log(1+uses) + 0.35*successRate + 0.2*recencyDecay(createdAt, halfLife=30d) + 0.15*generality; recencyDecay=exp(-ln2*days/30); generality=distinct tasks that retrieved it. Anti-regression: on outcome='failure' re-run acceptanceTest; fail -> quarantine "anti-regression check failed". Pinned excluded from eviction/tiering.
- U8: negative skills bypass the gate by design (impl='', test=''); status='verified' so they surface; DOCUMENT the rationale (records observed behavior, not proposed capability; single-tenant trust).
- check_strength surfaced in library_stats; skills < 2 flagged "shallow-tested".

## Sharpened unit specs (U5-U11) - condensed; full detail in task output

- U5 recall(store,embedder,query,{k=5,tokenBudget,tier?}) -> {selected, negatives, costEstimate, retrievalMs}. Scan hot-tier verified only. Rank cosine*(1+0.2*log(1+utility))*recencyDecay. Trim to tokenBudget (~150 tok/skill). SEPARATE pass: top-1 negative (kind='negative') with cosine>0.7, always included. Doc: context-cost O(k) tokens; compute-cost O(hot_set_size).
- U6 runSkill(store,id,input,{maxDepth=5,remainingMs}) -> {output,durationMs}. call() resolver, pre-resolve+validate (verified, acyclic via skill_deps, no cap-escalation), depth<=5, budget split per level, composed skill exercises full path. Cascade-quarantine via skill_deps on sub-skill demotion.
- U7 tier ('hot'/'warm'/'cold') + uses/successRate/pinned. Explicit weights above. reinforce(id, 'success'|'failure'). Tier top-N=200 hot. archived is a STATUS, cold is a TIER (any verified skill callable regardless of tier). Pinned never evicted/re-tiered.
- U8 recordFailure(store,{task,approach,reason}) -> kind='negative', status='verified', impl/test=''. recall returns {skills, negatives} separately; agent prompt: "KNOWN FAILURE MODES (check before retry)".
- U9 8 MCP tools: remember_skill, recall_skills, run_skill, record_failure, reinforce, library_stats, pin_skill, consolidate_now. library_stats: {total,verified,quarantined,negatives,hot,warm,cold,pinned,avgCheckStrength,weakTests,topSkills}.
- U10 consolidate(store,embedder,{dryRun}) -> {merged,evicted,flagged,durationMs}. Mutex + MDL + 3-instance min. praxis reindex.
- U11 bench/praxis-bench.ts: 60-task synthetic stream (20 head dedup / 20 long-tail / 20 composition), 2 arms (negatives_on/off), 5 curves -> results.json+csv. bench/README.md FIRST PARAGRAPH must contain "SYNTHETIC" (automated test). Completes < 60s (CI-able).

## Launch plan (summary)
README is the launch artifact (first 3 paragraphs = Show HN body). 30s terminal GIF: remember -> verify -> dedup(count stays 1) -> recall with negative surfaced -> `praxis stats`. The `praxis stats` line ("18 verified skills | 3 negatives | 0 re-learned this week | 4 tokens/task") is the shareable artifact. Sequence: Day1 Show HN ("agents that accumulate verified expertise, not just memories") -> Day2-3 X (GIF + negative-skill screenshot) -> Day4 npm publish -> Day5-7 r/LocalLLaMA + r/MachineLearning + dev.to -> Week2 Product Hunt (after stars move). The viral moment is the USER posting their own `praxis stats` after a week, not the launch post.

## Build order (gaps -> action)
Fix CRITICAL in U1/U2/U4 + add schema fields (HIGH) FIRST, with green captured tests + adversarial suite. THEN U5->U6->U7->U8->U9->U10->U11, each TDD red-green + commit. Synthesis specs are the authoritative acceptance criteria.
