/**
 * Fast focused checks (click status visibility + drag). ~15s.
 * Prereq: build + bridge built. Usage: node tests/quick-check.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bridge = path.join(root, 'dist-bridge', 'index.cjs')

const client = new Client({ name: 'cobrowse-quick', version: '0.1.0' })
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [bridge], cwd: root, stderr: 'inherit' })
)

const fixture = pathToFileURL(path.join(root, 'tests', 'fixture.html')).href
await client.callTool({ name: 'navigate', arguments: { url: fixture } })

// 1. click -> status visible within ttl window
const t0 = Date.now()
await client.callTool({ name: 'click', arguments: { target: '#hello' } })
const clickMs = Date.now() - t0
const check = await client.callTool({
  name: 'evaluate',
  arguments: {
    script:
      "const h = document.getElementById('__cobrowse_overlay_host'); const s = h && h.shadowRoot.querySelector('.cb-status'); return { visible: !!(s && s.classList.contains('visible')), text: s ? s.textContent.trim() : '' }"
  }
})
const status = JSON.parse(check.content[0].text)
console.log(`click tool took ${clickMs}ms`)
console.log(`status visible: ${status.visible} | text: ${status.text.replace(/\s+/g, ' ')}`)

// 2. drag
await client.callTool({ name: 'drag', arguments: { from: '#dragme', to: '#sel' } })
const dp = await client.callTool({
  name: 'evaluate',
  arguments: { script: "return document.getElementById('dragpos').textContent" }
})
console.log(`drag result: ${dp.content[0].text}`)

await client.close()
