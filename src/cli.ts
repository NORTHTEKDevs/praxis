import { argv, env, exit } from 'node:process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { SkillStore } from './store.ts'
import { Praxis } from './praxis.ts'
import { HashingEmbedder } from './embedder.ts'
import { consolidate, reindex } from './consolidate.ts'

const DIR = env.PRAXIS_DIR ?? join(homedir(), '.praxis')
const DB = join(DIR, 'praxis.db')

function open(): Praxis {
  mkdirSync(DIR, { recursive: true })
  return new Praxis(new SkillStore(DB), new HashingEmbedder())
}

const MCP_STANZA = JSON.stringify({ mcpServers: { praxis: { command: 'praxis', args: ['serve'] } } }, null, 2)

const cmd = argv[2]

if (cmd === 'init') {
  const px = open()
  const r = await px.remember({
    name: 'identity',
    interface: '(x)->x',
    implementation: 'return input',
    acceptanceTest: 'assert(run(1) === 1); assert(run(2) === 2)',
    task: 'self-test identity',
  })
  if (r.status !== 'verified') {
    console.error('praxis init self-test FAILED:', r.reason)
    exit(1)
  }
  console.log(`praxis initialized at ${DIR} (self-test OK)`)
  console.log('\nAdd this to your .mcp.json (Claude Code / Cursor):')
  console.log(MCP_STANZA)
} else if (cmd === 'stats') {
  console.log(JSON.stringify(open().stats(), null, 2))
} else if (cmd === 'consolidate') {
  console.log(JSON.stringify(await consolidate(open().store, new HashingEmbedder()), null, 2))
} else if (cmd === 'reindex') {
  console.log(`reindexed ${await reindex(open().store, new HashingEmbedder())} skills`)
} else if (cmd === 'serve') {
  await import('./mcp.ts')
} else {
  console.log('usage: praxis <init|serve|stats|consolidate|reindex>')
}
