// Prepack step 2 (after tsc): dist needs the plain-ESM sandbox worker, which tsc won't move.
import { cpSync } from 'node:fs'
cpSync('src/sandbox-worker.mjs', 'dist/sandbox-worker.mjs')
console.log('prepack: dist/sandbox-worker.mjs copied')
