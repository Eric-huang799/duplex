// 验收：锁定区拒绝 agent 修改 + 变体对比弹层。
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const dataDir = process.env.DUPLEX_DATA_DIR
const endpoint = JSON.parse(readFileSync(path.join(dataDir, 'endpoint.json'), 'utf8'))
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${endpoint.token}`, 'duplex-caller-id': 'design-agent-lock' } }
})
const client = new Client({ name: 'lock-check', version: '0.0.0' })
await client.connect(transport)
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args })
  return { isError: Boolean(r?.isError), text: (r?.content ?? []).filter((i) => i.type === 'text').map((i) => i.text).join('\n') }
}

// 1) 先锁定 card-a
const lock = await call('design_patch', { ops: [{ op: 'update', targetId: 'card-a', patch: { meta: { locked: true } } }] })
console.log('锁定 card-a:', lock.isError ? lock.text : lock.text.slice(0, 120))

// 2) agent 再改它 → 必须被拒绝
const blocked = await call('design_patch', { ops: [{ op: 'update', targetId: 'card-a-title', patch: { text: '应该被拒绝' } }] })
console.log('锁后修改（应失败）:', blocked.isError, blocked.text.slice(0, 200))

// 3) 解锁，保证画布可继续用
await call('design_patch', { ops: [{ op: 'update', targetId: 'card-a', patch: { meta: { locked: false } } }] })

// 4) 给 hero 发两个变体
const heroBox = (label, bg) => ({
  id: 'hero',
  type: 'stack',
  style: { padding: '96px 72px', gap: '24px', background: bg },
  children: [
    { id: 'hero-eyebrow', type: 'text', text: label, style: { color: 'brand.primary', fontSize: '13px', letterSpacing: '0.14em' } },
    { id: 'hero-title', type: 'heading', text: label + ' 主标题', style: { fontSize: '56px', lineHeight: '1.08' } },
    { id: 'hero-body', type: 'text', text: '这是变体演示的正文。', style: { color: 'text.muted', fontSize: '18px' } }
  ]
})
const variants = await call('design_variants', {
  blockId: 'hero',
  options: [heroBox('方案 A · 清爽', '#eef4ff'), heroBox('方案 B · 暖色', '#fff4e6')]
})
console.log('变体:', variants.isError ? variants.text : variants.text.slice(0, 160))
await client.close()

// 5) 画布上是否出现对比弹层
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2]}`)
const pages = []
for (const c of browser.contexts()) for (const p of c.pages()) pages.push(p)
const canvas = pages.find((p) => p.url().includes('/canvas/'))
await canvas.waitForTimeout(800)
const hasVariants = await canvas.evaluate(() => document.body.innerText.includes('方案'))
console.log('画布出现变体对比 =', hasVariants)
await canvas.screenshot({ path: `${process.env.TEMP}\\duplex-canvas-variants.png` })
console.log('screenshot:', `${process.env.TEMP}\\duplex-canvas-variants.png`)
await browser.close()
