/** Isolated Electron fixture entry. Never used by the installed application. */
import { app, BrowserWindow, webContents } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import readline from 'node:readline'
import fs from 'node:fs'
import http from 'node:http'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (!process.env.DUPLEX_DATA_DIR) throw new Error('The fixture requires DUPLEX_DATA_DIR')
app.getAppPath = () => root
app.setAppPath?.(root)
for (const method of ['show', 'showInactive', 'focus']) BrowserWindow.prototype[method] = function () {}
for (const flag of ['disable-background-timer-throttling', 'disable-renderer-backgrounding',
  'disable-backgrounding-occluded-windows', 'disable-background-networking']) app.commandLine.appendSwitch(flag)
app.on('web-contents-created', (_event, contents) => contents.setBackgroundThrottling(false))
app.on('session-created', (session) => {
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, done) => {
    const host = new URL(details.url).hostname
    done({ cancel: !['localhost', '127.0.0.1', '[::1]'].includes(host) })
  })
})

const wheels = new Map()
const reply = (id, result, error) => process.stdout.write(`PRIVATE029:${JSON.stringify({ id, result, error })}\n`)
function findPage(url) {
  const contents = webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL() === url)
  if (!contents) throw new Error(`Fixture page not found: ${url}`)
  return contents
}
const wheel = (contents) => contents.sendInputEvent({
  type: 'mouseWheel', x: 300, y: 250, deltaX: 0, deltaY: 7, wheelTicksX: 0, wheelTicksY: 1, canScroll: true
})

async function handleMessage(message) {
    const { command, url, script } = message
      if (command === 'quit') { setImmediate(() => app.quit()); return true }
      const contents = findPage(url)
      if (command === 'eval') return contents.executeJavaScript(script)
      else if (command === 'start-wheel') {
        await wheel(contents)
        const timer = setInterval(() => { try { wheel(contents) } catch {} }, 80)
        wheels.set(url, timer)
        return true
      } else if (command === 'stop-wheel') {
        clearInterval(wheels.get(url)); wheels.delete(url); return true
      } else if (command === 'pointer') {
        contents.sendInputEvent({ type: 'mouseDown', x: 40, y: 25, button: 'left', clickCount: 1 })
        contents.sendInputEvent({ type: 'mouseUp', x: 40, y: 25, button: 'left', clickCount: 1 })
        return true
      } else throw new Error(`Unknown fixture command: ${command}`)
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  void (async () => {
    const message = JSON.parse(line)
    try { reply(message.id, await handleMessage(message)) }
    catch (error) { reply(message.id, undefined, error.message) }
  })().catch((error) => process.stderr.write(`${error.stack}\n`))
})
// Windows GUI Electron can present EOF immediately on fd 0. Only an explicit
// quit command may terminate the app; a loopback fixture channel also works there.
const controlServer = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${process.env.DUPLEX_FIXTURE_CONTROL_TOKEN}`) {
    response.writeHead(401).end(); return
  }
  try {
    let body = ''
    for await (const chunk of request) { body += chunk; if (body.length > 65536) throw new Error('Fixture command too large') }
    const result = await handleMessage(JSON.parse(body))
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result }))
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }))
  }
})
await new Promise((resolve) => controlServer.listen(0, '127.0.0.1', resolve))
fs.writeFileSync(path.join(process.env.DUPLEX_DATA_DIR, 'fixture-control.json'), JSON.stringify({ port: controlServer.address().port, pid: process.pid }))
app.on('browser-window-created', (_event, window) => window.on('closed', () => process.stderr.write('[private fixture] window closed\n')))
app.on('quit', (_event, code) => process.stderr.write(`[private fixture] quit ${code}\n`))
app.on('before-quit', () => { for (const timer of wheels.values()) clearInterval(timer); wheels.clear(); controlServer.closeAllConnections(); controlServer.close() })
setTimeout(() => app.quit(), 150_000).unref()
const compiledEntry = path.join(root, 'out', 'main', 'index.js')
if (process.env.DUPLEX_FIXTURE_OFFSCREEN === '1') {
  // Test-only render preference: keep the compiled application and its source untouched.
  const temporaryEntry = path.join(root, 'out', 'main', `.private-smoke-${process.pid}.mjs`)
  const compiled = fs.readFileSync(compiledEntry, 'utf8')
  fs.writeFileSync(temporaryEntry, compiled.replaceAll('sandbox: true', 'sandbox: true, offscreen: true'))
  try { await import(pathToFileURL(temporaryEntry).href) }
  finally { fs.unlinkSync(temporaryEntry) }
} else await import(pathToFileURL(compiledEntry).href)
