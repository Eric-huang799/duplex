/**
 * Annotation visual preview: draw a box with the question card open, screenshot.
 * Usage: node tests/annot-preview.mjs  (after npm run build + build:bridge)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bridge = path.join(root, 'dist-bridge', 'index.cjs')

const client = new Client({ name: 'cobrowse-annot-preview', version: '0.1.0' })
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [bridge], cwd: root, stderr: 'inherit' })
)

const fixture = pathToFileURL(path.join(root, 'tests', 'fixture.html')).href
await client.callTool({ name: 'navigate', arguments: { url: fixture } })
await client.callTool({ name: 'annotation_mode', arguments: { active: true } })

const box = JSON.parse(
  (
    await client.callTool({
      name: 'evaluate',
      arguments: {
        script:
          "const a = document.getElementById('hello').getBoundingClientRect(); const b = document.getElementById('sel').getBoundingClientRect(); return { x1: Math.round(Math.min(a.left, b.left) - 14), y1: Math.round(a.top - 14), x2: Math.round(Math.max(a.right, b.right) + 14), y2: Math.round(b.bottom + 14) }"
      }
    })
  ).content[0].text
)

const drawScript =
  "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot;\n" +
  "const layer = sr.querySelector('.cb-annot-layer');\n" +
  `const x1 = ${box.x1}, y1 = ${box.y1}, x2 = ${box.x2}, y2 = ${box.y2};\n` +
  "layer.dispatchEvent(new MouseEvent('mousedown', { clientX: x1, clientY: y1, bubbles: true, button: 0 }));\n" +
  "window.dispatchEvent(new MouseEvent('mousemove', { clientX: (x1 + x2) / 2, clientY: (y1 + y2) / 2, bubbles: true }));\n" +
  "window.dispatchEvent(new MouseEvent('mousemove', { clientX: x2, clientY: y2, bubbles: true }));\n" +
  "window.dispatchEvent(new MouseEvent('mouseup', { clientX: x2, clientY: y2, bubbles: true }));\n" +
  "const sr2 = document.getElementById('__cobrowse_overlay_host').shadowRoot;\n" +
  "sr2.querySelector('.cb-card-input').value = '这个按钮和下拉框分别是做什么的？';\n" +
  "return 'ok'"

await client.callTool({ name: 'evaluate', arguments: { script: drawScript } })
await new Promise((r) => setTimeout(r, 400))

const shot = await client.callTool({ name: 'screenshot', arguments: {} })
const img = (shot?.content ?? []).find((c) => c.type === 'image')
if (img) {
  const out = path.join(root, 'tests', 'annot-preview.png')
  fs.writeFileSync(out, Buffer.from(img.data, 'base64'))
  console.log(`saved: ${out}`)
}
await client.close()
