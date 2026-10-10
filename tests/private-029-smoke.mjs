/** Real main-process integration smoke. Usage: node tests/private-029-smoke.mjs */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-private029-'))
const scrollOnly = process.env.DUPLEX_SMOKE_SCROLL_ONLY === '1'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
let child, endpoint, processExit, fixtureServer
let controlToken
let output = '', nextCommand = 1
const clients = []
const text = (result) => (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
const fixture = (pathname) => `<!doctype html><meta charset="utf-8"><title>Private 029 ${pathname}</title>
<style>body{margin:0;padding:65px 20px;font:16px sans-serif;height:3200px}#human{position:fixed;left:12px;top:12px;width:180px}#action{margin-top:1800px}#ai-input{display:block;margin:20px 0}</style>
<input id="human" value="human focus"><h1>Fixture ${pathname}</h1><p>Read marker ${pathname}</p>
<button id="action" onclick="document.body.dataset.clicked='yes'">Offscreen action</button><input id="ai-input"><p id="result"></p>
<script>window.trustedWheels=0;window.addEventListener('wheel',e=>{if(e.isTrusted)window.trustedWheels++},{passive:true});</script>`

async function until(fn, timeout = 5000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value } catch (error) { last = error }
    await sleep(80)
  }
  throw last ?? new Error(`Condition timed out after ${timeout} ms`)
}
async function check(label, fn) {
  const started = Date.now()
  try { await fn(); results.push({ label, ok: true, ms: Date.now() - started }); console.log(`[PASS] ${label}`) }
  catch (error) { results.push({ label, ok: false, error: error.message, ms: Date.now() - started }); console.log(`[FAIL] ${label}: ${error.message}`) }
}
async function api(route, body) {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
    headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000)
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}: ${JSON.stringify(result)}`)
  return result
}
async function panel(js) {
  const result = await api('/api/debug/panel-eval', { js })
  if (!result.ok) throw new Error(result.error)
  return result.result
}
async function command(command, url, script) {
  const control = JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture-control.json'), 'utf8'))
  const response = await fetch(`http://127.0.0.1:${control.port}`, {
    method: 'POST', headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ command, url, script }), signal: AbortSignal.timeout(6000)
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result.result
}
async function startApp() {
  const executable = process.platform === 'win32'
    ? path.join(root, 'node_modules/electron/dist/electron.exe')
    : (await import('electron')).default
  controlToken = randomUUID()
  const env = { ...process.env, DUPLEX_DATA_DIR: dataDir, COBROWSE_DEBUG_UI: '1',
    DUPLEX_FIXTURE_CONTROL_TOKEN: controlToken, DUPLEX_FIXTURE_OFFSCREEN: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key]
    env.Path = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${path.dirname(process.execPath)}`
  }
  child = spawn(executable, [path.join(root, 'tests/private-029-electron.mjs')], {
    cwd: root, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe']
  })
  let buffered = ''
  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString()
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) break
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1)
      if (line.startsWith('PRIVATE029:')) {
        // Explicit stdin quit remains available on platforms with a real stdin pipe.
      } else output = `${output}${line}\n`.slice(-18_000)
    }
  })
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-18_000) })
  child.stdin.on('error', () => {})
  processExit = new Promise((resolve) => { child.once('exit', (code) => resolve(code)); child.once('error', (error) => { output += error.stack; resolve(-1) }) })
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}: ${output.slice(-2000)}`)
    endpoint = JSON.parse(fs.readFileSync(path.join(dataDir, 'endpoint.json'), 'utf8'))
    const health = await api('/health')
    if (health.version !== '0.2.9') throw new Error(`Unexpected fixture version: ${health.version}`)
    return health.ok
  }, 15_000)
  await until(async () => await panel('Boolean(window.cobrowse && window.cobrowse.ready)'))
}
async function stopApp() {
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  if (!child || child.exitCode !== null) return
  try { await command('quit') } catch { child.stdin.end(`${JSON.stringify({ id: nextCommand++, command: 'quit' })}\n`) }
  if (await Promise.race([processExit.then(() => true), sleep(5000).then(() => false)])) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else child.kill('SIGKILL')
  await Promise.race([processExit, sleep(1000)])
}
async function mcp(caller) {
  const client = new Client({ name: 'private-029-smoke', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${endpoint.token}`, 'duplex-caller-id': caller } }
  }))
  clients.push(client)
  return {
    call: (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 12_000 }),
    read: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 12_000 })
      if (result.isError) throw new Error(text(result))
      return text(result)
    }
  }
}

try {
  fixtureServer = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(fixture(new URL(request.url, 'http://localhost').pathname))
  })
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${fixtureServer.address().port}`
  await startApp()
  const A = await mcp('mcp:private-A'), B = await mcp('mcp:private-B')
  const initial = JSON.parse(await A.read('list_tabs'))
  const tabA = initial.find((tab) => tab.active)?.id ?? initial[0].id
  await A.read('navigate', { tabId: tabA, url: `${base}/a` })
  let tabB
  if (!scrollOnly) {
  await check('MCP new_tab stays background and binds its caller', async () => {
    tabB = JSON.parse(await B.read('new_tab', { url: `${base}/b` })).tabId
    const tabs = JSON.parse(await A.read('list_tabs'))
    assert.equal(tabs.find((tab) => tab.active).id, tabA)
    assert.match(await B.read('snapshot'), /Fixture \/b/)
  })
  await panel(`window.cobrowse.tabAction({type:'switchTab',tabId:${tabB}})`)
  await check('switching the visible page does not redirect caller A', async () => {
    assert.match(await A.read('snapshot'), /Fixture \/a/)
    assert.doesNotMatch(await A.read('snapshot'), /Fixture \/b/)
  })
  }
  await panel(`window.cobrowse.tabAction({type:'switchTab',tabId:${tabA}})`)
  await command('eval', `${base}/a`, "document.getElementById('human').focus();window.scrollTo(0,250);true")
  await command('start-wheel', `${base}/a`)
  await check('trusted continuous human scrolling allows reads without pausing the task', async () => {
    await until(async () => await command('eval', `${base}/a`, 'window.trustedWheels > 0'))
    assert.match(await A.read('snapshot'), /Fixture \/a/)
    const state = await panel('window.cobrowse.collaborationGet()')
    const page = state.tabs.find((tab) => tab.tabId === tabA)
    assert.equal(page.scrolling, true); assert.equal(page.paused, false)
  })
  await check('AI element click and standard input preserve human focus and scroll', async () => {
    const before = await command('eval', `${base}/a`, '({y:scrollY,focus:document.activeElement.id})')
    assert.equal(before.focus, 'human')
    const clicked = await A.call('click', { target: '#action' })
    assert.equal(clicked.isError, undefined, text(clicked))
    const typed = await A.call('type', { target: '#ai-input', text: 'private 029' })
    assert.equal(typed.isError, undefined, text(typed))
    const after = await command('eval', `${base}/a`, "({y:scrollY,focus:document.activeElement.id,clicked:document.body.dataset.clicked,value:document.getElementById('ai-input').value})")
    assert.equal(after.focus, 'human'); assert.equal(after.clicked, 'yes'); assert.equal(after.value, 'private 029')
    // The person may scroll in either direction while the AI operates.
    assert.ok(Math.abs(after.y - before.y) < 200, JSON.stringify({ before, after }))
    const scrolling = JSON.parse(await A.read('scroll', { dy: 900 }))
    assert.equal(scrolling.scrolled, false)
  })
  await command('stop-wheel', `${base}/a`)
  if (!scrollOnly) {
  await check('trusted human pointer pauses writes while reads continue; per-page resume restores writes', async () => {
    await command('pointer', `${base}/a`)
    await until(async () => (await panel('window.cobrowse.collaborationGet()')).tabs.find((t) => t.tabId === tabA)?.paused)
    assert.match(await A.read('snapshot'), /Fixture \/a/)
    const rejected = await A.call('click', { target: '#action' })
    assert.equal(rejected.isError, true); assert.match(text(rejected), /人工|恢复/)
    assert.equal((await panel(`window.cobrowse.collaborationResume(${tabA})`)).ok, true)
    assert.match(await A.read('click', { target: '#action' }), /clicked/)
  })
  await check('address navigation IPC honors its captured target tab', async () => {
    await panel(`window.cobrowse.tabAction({type:'switchTab',tabId:${tabB}})`)
    await panel(`window.cobrowse.tabAction({type:'navigate',tabId:${tabA},url:${JSON.stringify(`${base}/a-next`)}})`)
    await until(async () => JSON.parse(await A.read('list_tabs')).find((t) => t.id === tabA)?.url === `${base}/a-next`)
    const tabs = JSON.parse(await A.read('list_tabs'))
    assert.equal(tabs.find((t) => t.id === tabB).url, `${base}/b`)
    assert.equal(tabs.find((t) => t.active).id, tabB)
    assert.match(await A.read('snapshot'), /Fixture \/a-next/)
    await panel(`window.cobrowse.collaborationResume(${tabA})`)
  })
  await check('external session state IPC matches an opened local transcript', async () => {
    assert.equal(await panel('window.cobrowse.externalState()'), null)
    const directory = path.join(dataDir, 'transcript-fixture'); fs.mkdirSync(directory)
    const file = path.join(directory, 'local.jsonl')
    fs.writeFileSync(file, `${JSON.stringify({ role: 'user', text: 'Private local transcript', ts: Date.now() })}\n`)
    const tool = await panel(`window.cobrowse.agentsAdd('Private smoke transcript',${JSON.stringify(directory)})`)
    assert.equal(tool.ok, true)
    const opened = await panel(`window.cobrowse.agentsSessionOpen(${JSON.stringify(tool.id)},'local',${JSON.stringify(file)})`)
    assert.equal(opened.ok, true)
    const state = await panel('window.cobrowse.externalState()')
    assert.equal(state.toolId, tool.id); assert.equal(state.sessionId, 'local')
    await panel('window.cobrowse.agentsSessionClose()')
    assert.equal(await panel('window.cobrowse.externalState()'), null)
  })
  await check('message consumers cannot steal targeted injections and retries keep their identity', async () => {
    await api('/api/session/report', { consumerID: 'private-consumer', sessions: [{ id: 'private-session', title: 'Private', updated: Date.now() }] })
    await api('/api/session/command', { action: 'select', sessionID: 'private-session' })
    const queued = await api('/api/chat', { text: 'private local injection' })
    assert.deepEqual(await api('/api/injections?consumerID=other&sessionID=other-session'), [])
    const [claimed] = await api('/api/injections?consumerID=private-consumer&sessionID=private-session')
    assert.equal(claimed.id, queued.id)
    assert.equal((await api('/api/injections/requeue', { id: claimed.id, consumerID: 'private-consumer' })).ok, true)
    const [retried] = await api('/api/injections?consumerID=private-consumer&sessionID=private-session')
    assert.equal(retried.id, queued.id)
    await panel('window.__privatePaused=false;window.cobrowse.onEmergencyState(s=>window.__privatePaused=s.paused);window.cobrowse.emergencyTakeover();true')
    await until(async () => await panel('window.__privatePaused === true'))
    assert.equal((await api('/api/injections/requeue', { id: claimed.id, consumerID: 'private-consumer' })).ok, false)
    assert.equal((await api('/api/injections/renew', { id: claimed.id, consumerID: 'private-consumer' })).ok, false)
    assert.equal((await A.call('list_tabs')).isError, true)
    assert.equal(await panel('window.__privatePaused'), true)
    await panel('window.cobrowse.resumeAi();true')
    await until(async () => await panel('window.__privatePaused === false'))
    assert.equal((await A.call('list_tabs')).isError, undefined)
  })
  await check('closing a bound page rejects later reads instead of using the visible page', async () => {
    await panel(`window.cobrowse.tabAction({type:'closeTab',tabId:${tabA}})`)
    const result = await A.call('snapshot')
    assert.equal(result.isError, true, text(result)); assert.match(text(result), /已关闭|明确选择/)
  })
  await A.read('new_tab', { url: `${base}/a-next` })
  const saved = JSON.parse(await A.read('list_tabs'))
  const expectedURLs = saved.map((t) => t.url)
  const expectedActiveURL = saved.find((t) => t.active).url
  await stopApp()
  await check('exit flushes browser session URLs and active page into isolated data', async () => {
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'browser-session.json'), 'utf8'))
    assert.deepEqual(stored.tabs.map((t) => t.url), expectedURLs)
    assert.equal(stored.tabs[stored.activeIndex].url, expectedActiveURL)
  })
  await startApp()
  const resumed = await mcp('mcp:private-restored')
  await check('restart restores every browser page and its active selection', async () => {
    const tabs = await until(async () => {
      const list = JSON.parse(await resumed.read('list_tabs'))
      return list.every((t) => !t.loading) && list.length === expectedURLs.length ? list : false
    })
    assert.deepEqual(tabs.map((t) => t.url), expectedURLs)
    assert.equal(tabs.find((t) => t.active).url, expectedActiveURL)
    assert.equal(await panel('window.cobrowse.externalState()'), null)
  })
  }
} catch (error) {
  results.push({ label: 'smoke setup or scenario progression', ok: false, error: error.stack })
  console.error(`[FAIL] smoke setup: ${error.stack}`)
} finally {
  await stopApp()
  if (fixtureServer) { fixtureServer.closeAllConnections(); await new Promise((resolve) => fixtureServer.close(resolve)) }
  const failures = results.filter((result) => !result.ok)
  const report = { passed: results.length - failures.length, failed: failures.length, results,
    ...(failures.length ? { dataDir, electronOutput: output.slice(-7000) } : {}) }
  if (process.env.DUPLEX_SMOKE_REPORT) fs.writeFileSync(process.env.DUPLEX_SMOKE_REPORT, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (failures.length) {
    console.error(`Retained isolated failure data: ${dataDir}\nElectron output tail:\n${output.slice(-7000)}`)
    process.exitCode = 1
  } else {
    const resolved = path.resolve(dataDir)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('duplex-private029-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}
