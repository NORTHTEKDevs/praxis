import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { SkillStore } from './store.ts'
import { HashingEmbedder } from './embedder.ts'
import { Praxis } from './praxis.ts'
import { buildTools, wrapTool } from './tools.ts'

// Thin stdio MCP server over the (tested) Praxis tools. The trust-critical logic and the
// error-envelope behavior are unit-tested in tools.test.ts / praxis.test.ts; this file is
// transport glue.
const DIR = process.env.PRAXIS_DIR ?? join(homedir(), '.praxis')
mkdirSync(DIR, { recursive: true })

const px = new Praxis(new SkillStore(join(DIR, 'praxis.db')), new HashingEmbedder())
const tools = buildTools(px)

const server = new Server({ name: 'praxis', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name)
  if (!tool) return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  return wrapTool(() => tool.handler((req.params.arguments ?? {}) as Record<string, unknown>))
})

await server.connect(new StdioServerTransport())
