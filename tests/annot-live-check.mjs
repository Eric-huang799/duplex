/**
 * Live annotation-toggle check against a running Duplex instance.
 * Usage: node tests/annot-live-check.mjs <path-to-endpoint.json>
 */
import fs from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const epArg = process.argv[2]
if (!epArg) {
  console.error('usage: node tests/annot-live-check.mjs <endpoint.json>')
  process.exit(1)
}
const ep = JSON.parse(fs.readFileSync(epArg, 'utf8'))
const auth = { authorization: `Bearer ${ep.token}` }
const base = `http://127.0.0.1:${ep.port}`

async function mcp(tool, args = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: auth }
  })
  const c = new Client({ name: 'annot-live-check', version: '0' })
  await c.connect(transport)
  const res = await c.callTool({ name: tool, arguments: args })
  await c.close()
  const text = (res.content ?? [])
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n')
  return text
}

async function debugExec(js) {
  const r = await fetch(`${base}/api/debug/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ target: 'chrome', js })
  })
  return await r.json()
}

const overlayState = async () =>
  mcp(
    'evaluate',
    {
      script:
        'const h=document.getElementById("__cobrowse_overlay_host"); const sr=h&&h.shadowRoot; const t=sr&&sr.querySelector(".cb-annot-tools"); return { host: !!h, tools: !!(t&&t.classList.contains("visible")) }'
    }
  )

console.log('== navigate ==')
console.log((await mcp('navigate', { url: 'https://example.com' })).split('\n')[0])
console.log('== before ==', await overlayState())

console.log('== annotationToggle #1 (via renderer API) ==')
console.log(await debugExec('(async () => { const r = await window.cobrowse.annotationToggle(); return JSON.stringify(r); })()'))
await new Promise((r) => setTimeout(r, 500))
console.log('== after #1 ==', await overlayState())

console.log('== annotationToggle #2 ==')
console.log(await debugExec('(async () => { const r = await window.cobrowse.annotationToggle(); return JSON.stringify(r); })()'))
await new Promise((r) => setTimeout(r, 500))
console.log('== after #2 ==', await overlayState())

console.log('== page-level Ctrl+Shift+A (before-input path) ==')
await mcp('press', { key: 'Control+Shift+A' })
await new Promise((r) => setTimeout(r, 500))
console.log('== after key ==', await overlayState())
