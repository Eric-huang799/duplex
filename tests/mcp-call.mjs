/**
 * Call one Duplex MCP tool over HTTP — usable from a terminal when the
 * current opencode session has no MCP tools loaded yet.
 *
 * Usage: node tests/mcp-call.mjs <tool> ['{"json":"args"}']
 *        node tests/mcp-call.mjs evaluate --script-file <path.js>
 * e.g.   node tests/mcp-call.mjs snapshot
 *        node tests/mcp-call.mjs navigate '{"url":"https://example.com"}'
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const argv = process.argv.slice(2)
const tool = argv[0]
if (!tool) {
  console.error('usage: node tests/mcp-call.mjs <tool> [json-args|--script-file <path>]')
  process.exit(1)
}

let toolArgs = {}
const sfIndex = argv.indexOf('--script-file')
if (sfIndex >= 0) {
  toolArgs = { script: fs.readFileSync(argv[sfIndex + 1], 'utf8') }
} else {
  toolArgs = JSON.parse(argv[1] ?? '{}')
}

const ep = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.cobrowse', 'endpoint.json'), 'utf8')
)
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ep.port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${ep.token}` } }
})
const client = new Client({ name: 'cobrowse-cli', version: '0.1.0' })
await client.connect(transport)
const res = await client.callTool({ name: tool, arguments: toolArgs })
const text = (res.content ?? [])
  .filter((c) => c.type === 'text')
  .map((c) => c.text)
  .join('\n')
console.log(text)
if (res.isError) process.exitCode = 1
await client.close()
