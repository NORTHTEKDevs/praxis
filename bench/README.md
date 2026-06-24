# Praxis Benchmark

**SYNTHETIC BENCHMARK.** The task stream is designed by the author. The dedup-friendly head shows sublinear library growth; the long-tail arm shows linear growth - both are honest representations of real workload behavior. Context-cost O(k): tokens sent to the agent are bounded by `k` and `tokenBudget` regardless of library size. Compute-cost for retrieval is O(hot-set size), bounded by the hot-set cap (NOT O(1)). The repeat-error delta shows the negative-skills benefit on this synthetic stream; real benefit depends on task repetition rate. These curves are existence proofs that the system works as designed, not general performance guarantees.

## What it measures

A 40-task synthetic stream in two arms (`negatives_on` / `negatives_off`):

- **head** (5 base patterns x 4 passes): repeated work. First occurrence learns a skill; later occurrences are solved by retrieving the existing one. Demonstrates capability reuse + sublinear library growth (dedup folds variants).
- **tail** (20 unique tasks): a realistic long tail that grows the library linearly. Shown and acknowledged.
- **repeat-error delta**: with `negatives_on`, a recorded failure is surfaced before a retry; with `negatives_off` it is not.

## Curves (written to `results.json` / `results.csv`)

1. `capability_growth` - fraction of head tasks solved by reuse
2. `library_size` - verified skill count vs tasks processed (sublinear head, linear tail)
3. `context_cost` - tokens per task vs library size (bounded by `tokenBudget`)
4. `retrieval_latency` - ms per retrieval (documents O(hot-set) compute cost)
5. `repeat_error_delta` - repeated-approach warnings: `negatives_on` vs `negatives_off`

## Run

```bash
node --experimental-strip-types --experimental-sqlite bench/praxis-bench.ts
```

Uses the deterministic `HashingEmbedder` (no network, reproducible). Completes in seconds, so it doubles as a CI regression check (`src/bench.test.ts`).
