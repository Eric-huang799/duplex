/**
 * Injection delivery latency test.
 * Opens a long-poll exactly like the opencode plugin does, then pushes a
 * message via /api/chat and measures how fast the poll receives it.
 *
 * Prereq: the browser must be running. Usage: node tests/inject-latency.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const endpointFile = path.join(os.homedir(), '.cobrowse', 'endpoint.json')
const ep = JSON.parse(fs.readFileSync(endpointFile, 'utf8'))
const base = `http://127.0.0.1:${ep.port}`
const auth = { authorization: `Bearer ${ep.token}` }

const pollPromise = fetch(`${base}/api/injections?wait=15000`, { headers: auth }).then((r) =>
  r.json()
)

await new Promise((r) => setTimeout(r, 400))
const tSend = Date.now()
const post = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ text: `延迟测试消息 ${tSend}` })
}).then((r) => r.json())

const items = await pollPromise
const latency = Date.now() - tSend

const got = Array.isArray(items) ? items.find((i) => i.id === post.id) : null
console.log(`pushed at t=0, long-poll received after ${latency} ms`)
console.log(`received item matches: ${!!got} (text="${got ? String(got.text).slice(0, 40) : 'NONE'}")`)

if (got) {
  await fetch(`${base}/api/injections/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ id: got.id })
  })
}

const passed = latency < 800 && !!got
console.log(passed ? 'LATENCY OK (<800ms)' : 'LATENCY FAIL')
process.exitCode = passed ? 0 : 1
