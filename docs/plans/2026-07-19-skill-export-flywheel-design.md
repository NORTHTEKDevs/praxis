# Praxis v1.0: Ship + SKILL.md Export + Flywheel Loop

Date: 2026-07-19. Status: approved.

## Goal

Take praxis from done-but-unshipped (README instructs `npm i -g @northtek/praxis`; package is unpublished and 404s) to a shipped v1.0 with one distinctive new capability: proven skills compile to real Claude Code SKILL.md files, and their lifecycle stays honest end-to-end. Usage data from the claude-code-flywheel Work Ledger feeds back into utility scoring via a soft adapter.

## Phase A: Ship prep

- Bump version to 1.0.0. Add a `files` whitelist to package.json.
- Verify install from a real `npm pack` tarball: global install, `praxis init` smoke, `praxis serve` handshake.
- README install section verified against the packed artifact, not the source tree.
- Publish is manual (interactive passkey, non-delegable): Kristian runs `npm publish --ignore-scripts`; verify after via registry HTTP.
- Public-repo commit identity: Northtek <info@northtek.io>, no co-author trailer.

## Phase B: Managed SKILL.md export

New module `src/export.ts`. One new MCP tool `sync_skills` + CLI `praxis sync`.

- Scope: verified hot-tier skills; pinned skills always. Default target `.claude/skills/` (project), `--global` for `~/.claude/skills/`.
- Layout per skill: `.claude/skills/praxis-<slug>/` containing `SKILL.md` + `impl.mjs` (the proven implementation) + the acceptance test exposed as a re-verify command.
- SKILL.md frontmatter: `name`, USE-WHEN-phrased `description` (colon-sanitized; YAML colon-space in descriptions is a known parse trap), and a `praxis:` metadata block (skill id, status, content hash, exportedAt).
- Manifest `.praxis-manifest.json` in the target dir records exported ids + hashes. Sync is idempotent: add new, update changed, and on quarantine/eviction mark the exported SKILL.md `[STALE - failed re-verify]` with `status: quarantined` in the metadata block (default) or remove it (`--prune`). Praxis never touches files absent from the manifest.
- Invariant carried end-to-end: no exported skill silently outlives its proof.

## Phase C: Flywheel soft adapter

New module `src/flywheel.ts`. Reads the claude-code-flywheel Work Ledger file format; it is not a dependency on the flywheel project.

- Source: `FLYWHEEL_LEDGER` env or `~/.claude/state/ledger.jsonl`. Absent file: no-op; praxis is fully functional without it.
- Incremental scan via a byte-offset cursor persisted in the praxis sqlite store; no full-file rescans.
- Filter skill events (`"skill":"praxis-*"`), join to skill ids through the export manifest, fold uses/ok into the existing `reinforce()` -> utility -> `retier()` path. No new scoring system.
- Unused exported skills decay under the existing 30-day recency half-life; next sync stales or prunes their SKILL.md.

## Error handling

- Ledger rotated/truncated: cursor beyond filesize resets to 0.
- Malformed ledger lines: skip, count, surface count in `library_stats`.
- Corrupt/missing manifest: rebuild by scanning `praxis-*` dirs for the `praxis:` metadata block.
- Read-only skills dir: report per-skill failure, do not crash the sync.

## Testing (node:test, existing CI on Node 24)

- Export round-trip: verify -> export -> quarantine -> sync marks stale.
- Manifest safety: sync never modifies or deletes a file it did not write.
- Description colon sanitization.
- Cursor incrementality and rotated-ledger reset.
- Missing-ledger no-op.
- Synthetic ledger measurably moves utility score through `reinforce()`.

## Success criteria

1. `npm i -g @northtek/praxis` works for real (registry-verified).
2. A synced SKILL.md loads in an actual Claude Code session.
3. Quarantine round-trip and flywheel reinforcement proven by executed tests.

## Out of scope (v1.1+)

Cross-agent skill sharing/registry, Python SDK, semantic embedder upgrade, flywheel cost-dollar attribution.
