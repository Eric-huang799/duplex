import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import electron from 'electron'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
const profile = await mkdtemp(join(tmpdir(), 'duplex-pw-'))
const bundle = resolve('tests/.playwright-smoke-layer.mjs')
const preload = resolve('tests/.playwright-smoke-preload.cjs')
await build({ entryPoints: ['tests/playwright-smoke-exports.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
await build({ entryPoints: ['src/overlay-preload/index.ts'], outfile: preload, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const layer = await import(pathToFileURL(bundle).href)
const child = spawn(electron, [resolve('tests/playwright-electron-fixture.cjs'), profile, preload], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
const events = []
let eventOutput = ''
child.stdout.on('data', chunk => {
  eventOutput += chunk
  const lines = eventOutput.split(/\r?\n/)
  eventOutput = lines.pop()
  for (const line of lines) if (line.startsWith('DUPLEX_EVENT ')) events.push(JSON.parse(line.slice('DUPLEX_EVENT '.length)))
})
let browser
try {
  const target = await new Promise((accept, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 15000)
    child.stdout.on('data', chunk => {
      output += chunk
      const match = output.match(/DUPLEX_FIXTURE (.+)/)
      if (match) { clearTimeout(timer); accept(JSON.parse(match[1])) }
    })
    child.once('exit', code => { clearTimeout(timer); reject(new Error('fixture exited ' + code)) })
  })
  const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  let matched = false
  for (const context of browser.contexts()) for (const page of context.pages()) {
    const session = await context.newCDPSession(page)
    const info = await session.send('Target.getTargetInfo')
    await session.detach()
    if (info.targetInfo.targetId === target.targetId) {
      await page.locator('#save').click({ timeout: 2000 })
      if (await page.evaluate(() => window.saved) !== 1) throw new Error('click failed')
      matched = true
    }
  }
  if (!matched) throw new Error('WebContentsView target not mapped')
  await new Promise(resolve => setTimeout(resolve, 30))
  events.length = 0
  layer.configurePlaywright(profile)
  const tab = { id: 11, view: { webContents: { debugger: { isAttached: () => true, sendCommand: async () => ({ targetInfo: target }) } } } }
  const page = await layer.pageForTab(tab)
  await page.evaluate(() => { window.pointerTrace = []; window.addEventListener('pointerdown', event => window.pointerTrace.push({ x: event.clientX, y: event.clientY, marker: document.documentElement.getAttribute('data-duplex-ai-input') }), true) })
  await page.locator('#b').focus()
  await page.evaluate(() => {
    window.scrollTo(0, 400)
    document.documentElement.setAttribute('data-duplex-human-scroll-until', String(Date.now() + 10000))
  })
  const before = await page.evaluate(() => ({ y: scrollY, focus: document.activeElement.id }))
  await layer.performPageAction(tab, 'type', { target: '#a', text: 'correct field' })
  await layer.performPageAction(tab, 'click', { target: '#save' })
  const scrollResult = await layer.performPageAction(tab, 'scroll', { dy: 1000 })
  const after = await page.evaluate(() => ({ y: scrollY, focus: document.activeElement.id, a: document.querySelector('#a').value, b: document.querySelector('#b').value, saved: window.saved }))
  if (after.y !== before.y || after.focus !== before.focus || after.a !== 'correct field' || after.b !== '' || after.saved !== 2 || scrollResult.scrolled !== false) throw new Error('continuous scrolling collaboration failed: ' + JSON.stringify({ before, after, scrollResult }))
  await page.evaluate(() => document.documentElement.removeAttribute('data-duplex-human-scroll-until'))
  const snapshot1 = await page.evaluate(layer.buildSnapshotScript())
  const snapshot2 = await page.evaluate(layer.buildSnapshotScript())
  const ref1 = snapshot1.match(/\[(e\d+)\]/)[1]
  const ref2 = snapshot2.match(/\[(e\d+)\]/)[1]
  if (ref1 === ref2) throw new Error('snapshot aliases reused')
  await layer.performPageAction(tab, 'type', { target: '#a', text: 'normal fill' })
  await layer.performPageAction(tab, 'click', { target: '#save' })
  await layer.performPageAction(tab, 'type', { target: '#shadow-input', text: 'shadow supported' })
  await layer.performPageAction(tab, 'click', { target: '#frame >>> #inner' })
  await layer.performPageAction(tab, 'press', { key: 'Control+A' })
  await layer.performPageAction(tab, 'press', { key: 'Shift+Tab' })
  await layer.performPageAction(tab, 'press', { key: 'Space' })
  if (!(await page.frameLocator('#frame').locator('#inner').evaluate(() => window.innerSaved))) throw new Error('iframe locator failed')
  const op = layer.beginOperation()
  const pending = layer.runInOperation(op, () => layer.performPageAction(tab, 'click', { target: '#absent' }))
  setTimeout(() => op.abort(), 80)
  let cancelled = false
  try { await pending } catch (error) { cancelled = /中断/.test(error.message) }
  layer.endOperation(op)
  if (!cancelled) throw new Error('waiting locator was not cancelled')
  const evalOp = layer.beginOperation()
  const evalPending = layer.runInOperation(evalOp, () => layer.performPageAction(tab, 'evaluate', { script: 'await new Promise(resolve => setTimeout(resolve, 400)); window.delayed = true; return true' }))
  setTimeout(() => evalOp.abort(), 80)
  try { await evalPending } catch {}
  layer.endOperation(evalOp)
  await new Promise(resolve => setTimeout(resolve, 450))
  if (await page.evaluate(() => window.delayed)) throw new Error('cancelled evaluate continued side effects')
  await new Promise(resolve => setTimeout(resolve, 30))
  if (events.some(event => event.kind === 'humanActivity')) throw new Error('AI actions misidentified as human input: ' + JSON.stringify({ events, pointerTrace: await page.evaluate(() => window.pointerTrace) }))
  await page.mouse.move(700, 400)
  await page.mouse.wheel(0, 100)
  await page.locator('#b').focus()
  await page.keyboard.press('x')
  await new Promise(resolve => setTimeout(resolve, 50))
  if (!events.some(event => event.kind === 'humanActivity' && event.activity === 'scroll') || !events.some(event => event.kind === 'humanActivity' && event.activity === 'key')) throw new Error('human events not captured: ' + JSON.stringify(events))
  const touchSession = await page.context().newCDPSession(page)
  const pointerCount = events.filter(event => event.kind === 'humanActivity' && event.activity === 'pointer').length
  await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 700, y: 550, id: 1 }] })
  await touchSession.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 700, y: 250, id: 1 }] })
  await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await new Promise(resolve => setTimeout(resolve, 50))
  if (events.filter(event => event.kind === 'humanActivity' && event.activity === 'pointer').length !== pointerCount) throw new Error('touch scrolling was misidentified as pointer takeover')
  await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 700, y: 250, id: 2 }] })
  await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await new Promise(resolve => setTimeout(resolve, 50))
  if (events.filter(event => event.kind === 'humanActivity' && event.activity === 'pointer').length <= pointerCount) throw new Error('touch tap takeover was not reported')
  await touchSession.detach()
  if (!(await page.evaluate(() => document.documentElement.getAttribute('data-duplex-document')))) throw new Error('document token not emitted')
  console.log(JSON.stringify({ portFile: true, targetMatched: true, locatorClick: true, preserveScrollAndFocus: true, stableRefs: true, normalFill: true, cancelledWait: true, cancelledEvaluate: true, shadowAndFrame: true, aiInputMarked: true, chordInputMarked: true, touchScrollAndTap: true, humanActivityCaptured: true, documentIdentity: true }))
} finally {
  await layer.closePlaywright()
  if (browser) await browser.close()
  child.kill()
  await new Promise(resolveExit => { if (child.exitCode !== null) resolveExit(); else child.once('exit', resolveExit) })
  await rm(profile, { recursive: true, force: true })
  await rm(bundle, { force: true })
  await rm(preload, { force: true })
}
