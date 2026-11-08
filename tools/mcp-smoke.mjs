// 端到端冒烟：以外部 agent 的身份（duplex-caller-id）走真实 MCP 链，
// 验证"身份 → 授权闸门 → 仲裁 → ref → 点击"整条链路通。
// 用法：node tools/mcp-smoke.mjs [callerId]
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const dataDir = process.env.DUPLEX_DATA_DIR ?? path.join(process.env.TEMP, 'duplex-030')
const callerId = process.argv[2] ?? 'smoke-agent-1'
const endpoint = JSON.parse(readFileSync(path.join(dataDir, 'endpoint.json'), 'utf8'))

const transport = new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${endpoint.port}/mcp`),
  {
    requestInit: {
      headers: { Authorization: `Bearer ${endpoint.token}`, 'duplex-caller-id': callerId }
    }
  }
)
const client = new Client({ name: 'duplex-smoke', version: '0.0.0' })
await client.connect(transport)

const textOf = (result) =>
  (result?.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  return { isError: Boolean(result?.isError), text: textOf(result) }
}

console.log('caller =', callerId)

const nav = await call('navigate', { url: 'http://127.0.0.1:8799/' })
console.log('navigate:', nav.isError ? `失败 ${nav.text.slice(0, 120)}` : 'ok')

const snap = await call('snapshot', {})
if (snap.isError) {
  console.error('snapshot 失败：', snap.text.slice(0, 300))
  await client.close()
  process.exit(1)
}

// 找到"计数按钮"那一行前面的 ref（带不带 a<actor>: 前缀都接受）
const ref = (() => {
  for (const line of snap.text.split('\n')) {
    if (!line.includes('计数按钮')) continue
    const match = /\[((?:a[\w.:-]+:)?e\d+)\]/.exec(line)
    if (match) return match[1]
  }
  return null
})()
console.log('button ref =', ref)
if (!ref) {
  console.error('快照里没找到按钮 ref，前 300 字：', snap.text.slice(0, 300))
  await client.close()
  process.exit(1)
}

const click = await call('click', { target: ref })
console.log('click:', click.isError ? `失败 ${click.text.slice(0, 200)}` : 'ok')

const read = await call('evaluate', { script: 'JSON.stringify({ count: window.__CLICKS__ ? window.__CLICKS__.count : -1 })' })
console.log('evaluate:', read.isError ? `失败 ${read.text.slice(0, 200)}` : read.text.slice(0, 200))

// 再用第二个身份读一次，确认它不会被第一个身份的操作阻塞（只读不受仲裁影响）
const second = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`), {
  requestInit: {
    headers: { Authorization: `Bearer ${endpoint.token}`, 'duplex-caller-id': 'smoke-agent-2' }
  }
})
const client2 = new Client({ name: 'duplex-smoke-2', version: '0.0.0' })
await client2.connect(second)
const read2 = await client2.callTool({
  name: 'evaluate',
  arguments: { script: 'JSON.stringify({ count: window.__CLICKS__ ? window.__CLICKS__.count : -1 })' }
})
console.log('second agent evaluate:', textOf(read2).slice(0, 200))

await client2.close()
await client.close()
console.log('smoke done')
