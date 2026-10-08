/**
 * Live annotation submit check for all three panel modes.
 * Usage: node tests/annot-submit-check.mjs <endpoint.json> <mode: agent|opencode|external>
 */
import fs from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const epPath = process.argv[2]
const mode = process.argv[3] ?? 'agent'
const ep = JSON.parse(fs.readFileSync(epPath, 'utf8'))
const auth = { authorization: `Bearer ${ep.token}` }
const base = `http://127.0.0.1:${ep.port}`

async function mcp(tool, args = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: auth }
  })
  const c = new Client({ name: 'annot-submit-check', version: '0' })
  await c.connect(transport)
  const res = await c.callTool({ name: tool, arguments: args })
  await c.close()
  return (res.content ?? [])
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n')
}

async function chromeExec(js) {
  const r = await fetch(`${base}/api/debug/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ target: 'chrome', js })
  })
  return (await r.json()).result
}

await fetch(`${base}/api/debug/ui-action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ action: `panel-mode:${mode}` })
})
await new Promise((r) => setTimeout(r, 400))

await mcp('navigate', { url: 'https://example.com' })
await new Promise((r) => setTimeout(r, 500))

// ensure annotation mode is ON (query first, then toggle only when needed)
const st0 = JSON.parse(
  await mcp('evaluate', {
    script:
      'const sr=document.getElementById("__cobrowse_overlay_host").shadowRoot; const t=sr.querySelector(".cb-annot-tools"); return JSON.stringify({on: !!(t&&t.classList.contains("visible"))})'
  })
)
if (!st0.on) {
  const on = await chromeExec(
    '(async () => { const r = await window.cobrowse.annotationToggle(); return JSON.stringify(r); })()'
  )
  console.log(`mode=${mode} toggle ->`, on)
  await new Promise((r) => setTimeout(r, 400))
} else {
  console.log(`mode=${mode} annotation already on`)
}

// draw a box over the page body and open the question card
await mcp('evaluate', {
  script:
    'const sr = document.getElementById("__cobrowse_overlay_host").shadowRoot;\n' +
    'const layer = sr.querySelector(".cb-annot-layer");\n' +
    'layer.dispatchEvent(new MouseEvent("mousedown", { clientX: 120, clientY: 160, bubbles: true, button: 0 }));\n' +
    'window.dispatchEvent(new MouseEvent("mousemove", { clientX: 320, clientY: 250, bubbles: true }));\n' +
    'window.dispatchEvent(new MouseEvent("mouseup", { clientX: 320, clientY: 250, bubbles: true }));\n' +
    'return "drawn"'
})
await new Promise((r) => setTimeout(r, 400))

// fill the question and send
await mcp('evaluate', {
  script:
    'const sr = document.getElementById("__cobrowse_overlay_host").shadowRoot;\n' +
    'const c = sr.querySelector(".cb-annot-card");\n' +
    'c.querySelector(".cb-card-input").value = "这是标注提交测试问题？";\n' +
    'c.querySelector(".cb-send").click();\n' +
    'return "sent"'
})
await new Promise((r) => setTimeout(r, 900))

const status = await mcp('evaluate', {
  script:
    'const sr = document.getElementById("__cobrowse_overlay_host").shadowRoot;\n' +
    'const s = sr.querySelector(".cb-status");\n' +
    'return { text: s.textContent.trim(), visible: s.classList.contains("visible"), cls: s.className }'
})
console.log('overlay status ->', JSON.stringify(status))

const panel = await chromeExec(
  '(() => { const p = document.querySelector(".panel"); const t = p ? p.innerText : "(no panel)"; return t.slice(0, 400); })()'
)
console.log('panel contains question ->', typeof panel === 'string' && panel.includes('这是标注提交测试问题'))

// toggle annotation back off
await chromeExec('(async () => { const r = await window.cobrowse.annotationToggle(); return JSON.stringify(r); })()')
