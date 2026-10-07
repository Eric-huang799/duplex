/**
 * Visual + takeover check:
 * 1. Click with overlay animation, screenshot mid-flight (cursor/highlight/status visible)
 * 2. Simulate the user pressing the CONFIGURED emergency-stop key -> next tool call
 *    must be blocked with a takeover notice
 * 3. The call after that must work normally again
 *
 * Prereq: npm run build && npm run build:bridge (browser can be running already)
 * Usage:  node tests/visual-check.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bridge = path.join(root, 'dist-bridge', 'index.cjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Use whatever emergency key this machine has configured (defaults to F2).
const settingsFile = path.join(os.homedir(), '.cobrowse', 'settings.json')
const stopKey = (() => {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    if (Array.isArray(s.emergencyStopKeys) && s.emergencyStopKeys.length > 0) {
      return s.emergencyStopKeys[0]
    }
  } catch {
    /* fall through to the default */
  }
  return 'F2'
})()

function stopKeyEvent() {
  const parts = stopKey.split('+').map((p) => p.trim())
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  return {
    key,
    ctrlKey: mods.some((m) => /^ctrl(rol)?$/i.test(m)),
    altKey: mods.some((m) => /^alt$|^option$/i.test(m)),
    shiftKey: mods.some((m) => /^shift$/i.test(m)),
    metaKey: mods.some((m) => /^(meta|win|windows|cmd|command)$/i.test(m)),
    bubbles: true
  }
}
const stopKeyScript = `window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(stopKeyEvent())})); return 'stop key sent'`

function firstText(result) {
  const item = (result?.content ?? []).find((c) => c.type === 'text')
  return item?.text ?? ''
}

function ok(label, cond, extra = '') {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) process.exitCode = 1
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bridge],
  cwd: root,
  stderr: 'inherit'
})
const client = new Client({ name: 'cobrowse-visual-check', version: '0.1.0' })
await client.connect(transport)

const fixtureUrl = pathToFileURL(path.join(root, 'tests', 'fixture.html')).href
await client.callTool({ name: 'navigate', arguments: { url: fixtureUrl } })

// --- 1. click + screenshot mid-flight ---
const snap = firstText(await client.callTool({ name: 'snapshot', arguments: {} }))
const btnRef = (snap.match(/\[(e\d+)\][^\n]*<button[^>]*>[^\n]*"点我"/) || [])[1]
ok('button ref found', !!btnRef, btnRef ?? '')

if (btnRef) {
  await client.callTool({ name: 'click', arguments: { target: btnRef } })

  const state = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const h = document.getElementById('__cobrowse_overlay_host'); const r = h && h.shadowRoot; const c = r && r.querySelector('.cb-cursor'); const hl = r && r.querySelector('.cb-highlight'); const st = r && r.querySelector('.cb-status'); return { cursor: !!(c && c.classList.contains('visible')), highlight: !!(hl && hl.classList.contains('visible')), status: !!(st && st.classList.contains('visible')), statusText: st ? st.textContent.trim() : '' }"
        }
      })
    )
  )
  ok('cursor visible', state.cursor === true)
  ok('highlight visible', state.highlight === true)
  ok('status visible', state.status === true, state.statusText.replace(/\s+/g, ' '))

  const shot = await client.callTool({ name: 'screenshot', arguments: {} })
  const img = (shot?.content ?? []).find((c) => c.type === 'image')
  if (img) {
    const out = path.join(root, 'tests', 'visual-check.png')
    fs.writeFileSync(out, Buffer.from(img.data, 'base64'))
    console.log(`       screenshot saved: ${out}`)
  }
}

// --- 2. emergency-stop key latches the AI off; a user message resumes it ---
console.log(`       using emergency key: ${stopKey}`)
await client.callTool({
  name: 'evaluate',
  arguments: { script: stopKeyScript }
})
await sleep(400)
const blocked = firstText(await client.callTool({ name: 'list_tabs', arguments: {} }))
ok(
  'next call blocked after emergency key',
  blocked.includes('已急停挂起'),
  blocked.slice(0, 60).replace(/\s+/g, ' ')
)

// Simulate the user resuming from the UI — explicit API, queues no message
const ep = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.cobrowse', 'endpoint.json'), 'utf8'))
const apiBase = `http://127.0.0.1:${ep.port}`
const authHeaders = { authorization: `Bearer ${ep.token}` }
const resumeAi = async () => {
  await fetch(`${apiBase}/api/emergency/resume`, { method: 'POST', headers: authHeaders })
}
await resumeAi()
await sleep(300)
const after = firstText(await client.callTool({ name: 'list_tabs', arguments: {} }))
ok('user message resumes the AI', after.includes('"id"'), after.slice(0, 60).replace(/\s+/g, ' '))

// --- 3. in-flight interruption: a running wait is aborted by the stop key immediately ---
await sleep(1000)
const waitPromise = client.callTool({ name: 'wait', arguments: { ms: 5000 } })
await sleep(800)
await client.callTool({
  name: 'evaluate',
  arguments: { script: stopKeyScript }
})
const waitRes = await waitPromise
const wt = JSON.parse(firstText(waitRes))
ok(
  `in-flight wait aborted by ${stopKey} (returns early)`,
  wt.interrupted === true && (wt.waitedMs ?? 99999) < 4000,
  JSON.stringify(wt)
)

// leave the browser resumed so a later session is not stuck
await resumeAi()
await sleep(300)
const finalText = firstText(await client.callTool({ name: 'list_tabs', arguments: {} }))
ok('cleanup: AI resumed', finalText.includes('"id"') || finalText.includes('已急停挂起') === false)

await client.close()
console.log(process.exitCode ? '\nvisual-check: FAILED' : '\nvisual-check: ALL PASSED')
process.exit(process.exitCode ?? 0)
