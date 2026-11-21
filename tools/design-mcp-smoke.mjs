// agent 侧验收：design_open/read/patch/commit/export 全链路走真实 MCP。
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const dataDir = process.env.DUPLEX_DATA_DIR ?? path.join(process.env.TEMP, 'duplex-design-accept')
const callerId = process.argv[2] ?? 'design-agent-1'
const endpoint = JSON.parse(readFileSync(path.join(dataDir, 'endpoint.json'), 'utf8'))

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${endpoint.token}`, 'duplex-caller-id': callerId } }
})
const client = new Client({ name: 'design-smoke', version: '0.0.0' })
await client.connect(transport)

const textOf = (result) =>
  (result?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n')
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  return { isError: Boolean(result?.isError), text: textOf(result) }
}

console.log('caller =', callerId)
const open = await call('design_open', {})
console.log('design_open:', open.isError ? open.text : open.text.slice(0, 240))

const read1 = await call('design_read', { maxDepth: 3 })
console.log('design_read 前 6 行:')
console.log(read1.text.split('\n').slice(0, 6).join('\n'))

const patched = await call('design_patch', {
  ops: [
    {
      op: 'insert',
      parentId: 'root',
      node: {
        id: 'quotes',
        type: 'stack',
        style: { padding: '56px 72px', gap: '16px', background: '#f8fafc' },
        children: [
          { id: 'quotes-title', type: 'heading', text: '他们在用', style: { fontSize: '28px' } },
          {
            id: 'quote-1',
            type: 'box',
            style: { padding: '20px', borderRadius: 'radius.md', border: '1px solid line.soft' },
            children: [{ id: 'quote-1-text', type: 'text', text: '“拖一下就行，不用再描述半天。”' }]
          },
          {
            id: 'quote-2',
            type: 'box',
            style: { padding: '20px', borderRadius: 'radius.md', border: '1px solid line.soft' },
            children: [{ id: 'quote-2-text', type: 'text', text: '“改坏了能回退，这对设计很重要。”' }]
          }
        ]
      }
    },
    { op: 'update', targetId: 'hero-title', patch: { text: '和 AI 一起，把想法变成能交付的页面' } }
  ]
})
console.log('design_patch:', patched.isError ? patched.text : patched.text.slice(0, 200))

const read2 = await call('design_read', { maxDepth: 2 })
console.log('插入后是否包含 quotes =', read2.text.includes('quotes'), '| 标题已改 =', read2.text.includes('能交付的页面'))

const commit = await call('design_commit', { summary: '验收：新增口碑区块并改主标题' })
console.log('design_commit:', commit.text)

const exported = await call('design_export', {})
console.log('design_export:', exported.text)
const zipPath = exported.text.replace(/^已导出：/, '').trim()
console.log('zip 存在 =', existsSync(zipPath))

await client.close()
