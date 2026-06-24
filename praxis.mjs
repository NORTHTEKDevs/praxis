#!/usr/bin/env node
// Bin shim: runs the TypeScript CLI with the Node 24 flags it needs (native type-stripping
// + node:sqlite), so `praxis <cmd>` works after a global install with no build step.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('./src/cli.ts', import.meta.url))
const r = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--experimental-sqlite', cli, ...process.argv.slice(2)],
  { stdio: 'inherit' },
)
process.exit(r.status ?? 0)
