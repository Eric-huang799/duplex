// Debug helper: run JS in the Duplex panel renderer (requires COBROWSE_DEBUG_UI=1).
// Usage: node scripts/panel-eval.mjs "document.title"
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const js = process.argv.slice(2).join(' ')
if (!js) {
  console.error('usage: node scripts/panel-eval.mjs "<javascript>"')
  process.exit(1)
}
const epPath = path.join(os.homedir(), '.cobrowse', 'endpoint.json')
const ep = JSON.parse(fs.readFileSync(epPath, 'utf8'))
const res = await fetch(`http://127.0.0.1:${ep.port}/api/debug/panel-eval`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
  body: JSON.stringify({ js })
})
const data = await res.json()
console.log(JSON.stringify(data))
