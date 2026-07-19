#!/usr/bin/env node
// Bin shim. Published installs run plain JS from dist/ (Node 24 refuses type-stripping under
// node_modules). Repo checkouts fall back to src/*.ts via native type-stripping - no build step
// for dev and tests.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('./dist/cli.js', import.meta.url))
const args = existsSync(dist)
  ? ['--experimental-sqlite', dist]
  : ['--experimental-strip-types', '--experimental-sqlite', fileURLToPath(new URL('./src/cli.ts', import.meta.url))]
const r = spawnSync(process.execPath, [...args, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(r.status ?? 0)
