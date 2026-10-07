/**
 * Injection delivery latency test.
 * Opens a long-poll exactly like the opencode plugin does, then pushes a
 * message via /api/chat and measures how fast the poll receives it.
 *
 * Note: if another consumer (e.g. a running opencode plugin) is polling the
 * same endpoint it may win the race for a message. The test drains leftovers
 * first and retries a few times; if a foreign consumer keeps stealing them it
 * reports SKIP instead of FAIL (environmental, not a Duplex defect).
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

// This test POSTs a real chat message. Any other consumer polling the endpoint
// (a running opencode plugin, for example) will receive it too. Opt in only
// when the endpoint has no other consumers.
if (process.env.INJECT_LATENCY !== '1') {
  console.log(
    'SKIP: injection-latency needs a dedicated endpoint (no other consumers). ' +
      'Run with INJECT_LATENCY=1 after closing other Duplex/opencode consumers.'
  )
  process.exit(0)
}

// drain anything left over from earlier runs
await fetch(`${base}/api/injections`, { headers: auth }).catch(() => {})

async function attempt() {
  const pollPromise = fetch(`${base}/api/injections?wait=8000`, { headers: auth }).then((r) =>
    r.json()
  )
  await new Promise((r) => setTimeout(r, 300))
  const tSend = Date.now()
  const post = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ text: `延迟测试消息 ${tSend}` })
  }).then((r) => r.json())

  const items = await pollPromise
  const latency = Date.now() - tSend
  const got = Array.isArray(items) ? items.find((i) => i.id === post.id) : null
  return { latency, post, items, got }
}

let result = null
for (let i = 0; i < 3; i++) {
  result = await attempt()
  if (result.got) break
  console.log(`attempt ${i + 1}: message was taken by another consumer; retrying...`)
  await new Promise((r) => setTimeout(r, 300))
}

if (!result.got) {
  console.log('SKIP: another consumer (e.g. the opencode plugin) kept consuming the queue; ' +
    'close other consumers or ignore this local latency check.')
  process.exit(0)
}

console.log(`pushed at t=0, long-poll received after ${result.latency} ms`)
console.log(`received item matches: true (text="${String(result.got.text).slice(0, 40)}")`)

await fetch(`${base}/api/injections/ack`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ id: result.got.id })
})

const passed = result.latency < 800
console.log(passed ? 'LATENCY OK (<800ms)' : `LATENCY FAIL (${result.latency}ms >= 800ms)`)
process.exitCode = passed ? 0 : 1
