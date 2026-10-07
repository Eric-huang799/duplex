import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from 'electron'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { toolDefs } from '../shared/tools'
import type { MirrorPush, MirrorStore } from './mirror'
import type { TabManager } from './tabs'
import type { ToolExecutor } from './tool-handlers'
import type { SessionBus, SessionCommand } from './session-bus'

export interface HttpServerDeps {
  token: string
  version: string
  mirror: MirrorStore
  tabs: TabManager
  executeTool: ToolExecutor
  sessionBus: SessionBus
  /** Debug helper: capture the browser UI window, returns the written file path. */
  captureUI?: () => Promise<string | null>
  /** Debug helper (only wired when COBROWSE_DEBUG_UI=1): run JS in the panel renderer. */
  panelEval?: (js: string) => Promise<unknown>
  /** Debug helpers (only wired when COBROWSE_DEBUG_UI=1): synthetic input injection. */
  debugExec?: (target: 'chrome' | 'page', js: string) => Promise<unknown>
  debugKey?: (
    target: 'chrome' | 'page',
    key: string,
    modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
  ) => Promise<void>
  debugType?: (target: 'chrome' | 'page', text: string, delayMs?: number) => Promise<void>
  /** Built-in agent control; resolves with the run result (or void). */
  sendAgent?: (text: string) => Promise<void | { ok?: boolean; error?: string }>
  agentBusy?: () => boolean
  /** Returns false when the panel is mirroring an external tool (drop opencode pushes). */
  mirrorGate?: () => boolean
  /** A user-originated send went through this HTTP API (resumes after emergency stop). */
  onUserActivity?: () => void
}

export interface RunningHttpServer {
  port: number
  close: () => void
}

const MAX_BODY = 4 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

const PUSH_KINDS = new Set(['text', 'reasoning', 'tool', 'session', 'annotation', 'session-info'])

/** Debug routes must never be reachable in a packaged (production) build. */
function debugRoutesEnabled(): boolean {
  try {
    return app.isPackaged !== true
  } catch {
    return true
  }
}

function isLocalOriginHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
}

function isValidPush(b: unknown): b is MirrorPush {
  if (!b || typeof b !== 'object') return false
  const o = b as { kind?: unknown; text?: unknown; ts?: unknown }
  if (typeof o.kind !== 'string' || !PUSH_KINDS.has(o.kind)) return false
  if (o.ts !== undefined && (typeof o.ts !== 'number' || !Number.isFinite(o.ts))) return false
  if (o.text !== undefined && typeof o.text !== 'string') return false
  return true
}

export async function startHttpServer(deps: HttpServerDeps): Promise<RunningHttpServer> {
  const server = http.createServer((req, res) => {
    void handle(req, res, deps).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: (e as Error)?.message ?? String(e) })
      else res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () => server.close()
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')

  // CORS: only local pages (or no Origin at all, e.g. node/curl scripts) get
  // the ACAO header — an arbitrary web page must not be able to read replies.
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
  let originAllowed = true
  if (origin) {
    try {
      originAllowed = isLocalOriginHost(new URL(origin).hostname)
    } catch {
      originAllowed = false
    }
  }
  if (originAllowed) res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id'
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true, name: 'duplex', version: deps.version })
    return
  }

  const auth = req.headers.authorization ?? ''
  const authorized = auth === `Bearer ${deps.token}`
  if (!authorized) {
    sendJson(res, 401, { error: 'unauthorized (missing or bad bearer token)' })
    return
  }

  if (url.pathname === '/mcp') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed (stateless JSON mode: POST only)' })
      return
    }
    const body = await readBody(req)
    await handleMcpPost(req, res, body, deps)
    return
  }

  if (url.pathname === '/api/session/command' && req.method === 'POST') {
    const body = (await readBody(req)) as SessionCommand | undefined
    const action = body?.action
    if (action !== 'list' && action !== 'select' && action !== 'create') {
      sendJson(res, 400, { error: 'action must be list | select | create' })
      return
    }
    if (action === 'select') {
      // session selection is authoritative in the main process — every plugin
      // instance reads it from /api/session/state, so no command broadcast
      deps.sessionBus.select({ sessionID: body?.sessionID ?? null, title: body?.title })
      deps.mirror.add({
        kind: 'session-info',
        activeSessionID: deps.sessionBus.state.activeSessionID,
        activeTitle: deps.sessionBus.state.activeTitle ?? undefined,
        reason: deps.sessionBus.state.activeSessionID ? 'selected' : 'auto'
      })
      if (deps.sessionBus.state.activeSessionID) {
        deps.sessionBus.push({
          action: 'history',
          sessionID: deps.sessionBus.state.activeSessionID
        })
      }
      sendJson(res, 200, { ok: true })
      return
    }
    deps.sessionBus.push(body as SessionCommand)
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === '/api/session/command' && req.method === 'GET') {
    const waitMs = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), 30000)
    const items =
      waitMs > 0 ? await deps.sessionBus.waitForCommands(waitMs) : []
    sendJson(res, 200, items)
    return
  }

  if (url.pathname === '/api/session/report' && req.method === 'POST') {
    const body = (await readBody(req)) as
      | {
          activeSessionID?: string | null
          activeTitle?: string | null
          sessions?: Array<{ id: string; title: string; updated: number }>
          reason?: string
        }
      | undefined
    if (!body) {
      sendJson(res, 400, { error: 'body required' })
      return
    }
    deps.sessionBus.report(body)
    const gateOk = !deps.mirrorGate || deps.mirrorGate() || body.reason === 'listed'
    if (gateOk) {
      deps.mirror.add({
        kind: 'session-info',
        activeSessionID: deps.sessionBus.state.activeSessionID,
        activeTitle: deps.sessionBus.state.activeTitle ?? undefined,
        sessions: body.sessions,
        reason:
          (body.reason as 'listed' | 'selected' | 'created' | 'auto' | undefined) ?? undefined
      })
    }
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === '/api/session/state' && req.method === 'GET') {
    sendJson(res, 200, deps.sessionBus.state)
    return
  }

  if (url.pathname === '/api/agent/send' && req.method === 'POST') {
    const body = (await readBody(req)) as { text?: string } | undefined
    const text = String(body?.text ?? '').trim()
    if (!text) {
      sendJson(res, 400, { error: 'text is required' })
      return
    }
    if (!deps.sendAgent) {
      sendJson(res, 501, { error: 'agent not available' })
      return
    }
    deps.onUserActivity?.()
    // Await the run so immediate failures (missing config, bad credentials)
    // are reported instead of silently swallowed. A long run keeps this
    // request open until the agent finishes; callers may poll
    // /api/agent/state meanwhile.
    try {
      const result = await deps.sendAgent(text)
      if (result && result.ok === false) {
        sendJson(res, 500, { ok: false, error: result.error ?? 'agent failed to start' })
      } else {
        sendJson(res, 200, { ok: true })
      }
    } catch (e) {
      sendJson(res, 500, { ok: false, error: (e as Error)?.message ?? String(e) })
    }
    return
  }

  if (url.pathname === '/api/agent/state' && req.method === 'GET') {
    sendJson(res, 200, { running: deps.agentBusy ? deps.agentBusy() : false })
    return
  }

  if (url.pathname === '/api/mirror/events' && req.method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500)
    const all = deps.mirror.snapshot()
    sendJson(res, 200, all.slice(-limit))
    return
  }

  if (url.pathname === '/api/mirror' && req.method === 'POST') {
    const body = await readBody(req)
    const items = Array.isArray(body) ? body : [body]
    // When the panel is connected to a specific session, drop events from
    // other sessions here (single point of truth — plugin instances may
    // disagree, and the main process is authoritative).
    const active = deps.sessionBus.state.activeSessionID
    let accepted = 0
    let skipped = 0
    for (const item of items) {
      if (!isValidPush(item)) continue
      const sid = String((item as { sessionID?: unknown }).sessionID ?? '')
      if (active && sid && sid !== active) {
        skipped++
        continue
      }
      if (deps.mirrorGate && !deps.mirrorGate()) {
        skipped++
        continue
      }
      deps.mirror.add(item)
      accepted++
    }
    sendJson(res, 200, { ok: true, accepted, skipped })
    return
  }

  // In a packaged build the debug routes below are not served at all: requests
  // fall through to the final 404.
  const debugOk = debugRoutesEnabled()

  if (debugOk && url.pathname === '/api/debug/ui-snapshot' && req.method === 'GET') {
    if (!deps.captureUI) {
      sendJson(res, 501, { error: 'captureUI not available' })
      return
    }
    const file = await deps.captureUI()
    sendJson(res, 200, { ok: !!file, path: file })
    return
  }

  if (debugOk && url.pathname === '/api/debug/panel-eval' && req.method === 'POST') {
    if (!deps.panelEval) {
      sendJson(res, 501, { error: 'panelEval not available (set COBROWSE_DEBUG_UI=1)' })
      return
    }
    const body = (await readBody(req)) as { js?: string } | undefined
    const js = body?.js ?? ''
    if (!js) {
      sendJson(res, 400, { error: 'js is required' })
      return
    }
    try {
      const result = await deps.panelEval(js)
      let safe: unknown = null
      try {
        safe = JSON.parse(JSON.stringify(result ?? null))
      } catch {
        safe = String(result)
      }
      sendJson(res, 200, { ok: true, result: safe })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e) })
    }
    return
  }

  if (debugOk && url.pathname === '/api/debug/exec' && req.method === 'POST') {
    if (!deps.debugExec) {
      sendJson(res, 501, { error: 'debugExec not available (set COBROWSE_DEBUG_UI=1)' })
      return
    }
    const body = (await readBody(req)) as { target?: string; js?: string } | undefined
    const js = body?.js ?? ''
    if (!js) {
      sendJson(res, 400, { error: 'js is required' })
      return
    }
    try {
      const result = await deps.debugExec(body?.target === 'page' ? 'page' : 'chrome', js)
      let safe: unknown = null
      try {
        safe = JSON.parse(JSON.stringify(result ?? null))
      } catch {
        safe = String(result)
      }
      sendJson(res, 200, { ok: true, result: safe })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e) })
    }
    return
  }

  if (debugOk && url.pathname === '/api/debug/key' && req.method === 'POST') {
    if (!deps.debugKey) {
      sendJson(res, 501, { error: 'debugKey not available (set COBROWSE_DEBUG_UI=1)' })
      return
    }
    const body = (await readBody(req)) as
      | { target?: string; key?: string; modifiers?: string[] }
      | undefined
    const key = body?.key ?? ''
    if (!key) {
      sendJson(res, 400, { error: 'key is required' })
      return
    }
    try {
      const mods = (body?.modifiers ?? []).filter(
        (m): m is 'shift' | 'control' | 'alt' | 'meta' =>
          m === 'shift' || m === 'control' || m === 'alt' || m === 'meta'
      )
      await deps.debugKey(body?.target === 'page' ? 'page' : 'chrome', key, mods)
      sendJson(res, 200, { ok: true })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e) })
    }
    return
  }

  if (debugOk && url.pathname === '/api/debug/type' && req.method === 'POST') {
    if (!deps.debugType) {
      sendJson(res, 501, { error: 'debugType not available (set COBROWSE_DEBUG_UI=1)' })
      return
    }
    const body = (await readBody(req)) as
      | { target?: string; text?: string; delayMs?: number }
      | undefined
    const text = body?.text ?? ''
    try {
      await deps.debugType(
        body?.target === 'page' ? 'page' : 'chrome',
        text,
        Number(body?.delayMs) || 50
      )
      sendJson(res, 200, { ok: true, typed: text.length })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e) })
    }
    return
  }

  if (url.pathname === '/api/injections' && req.method === 'GET') {
    const waitMs = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), 30000)
    // A consumer is polling: let the mirror know so idle re-delivery stops
    // (optional method — provided by mirror.ts).
    ;(deps.mirror as unknown as { touchConsumer?: () => void }).touchConsumer?.()
    // Both modes TAKE: with several plugin instances polling, peeking would
    // deliver the same message to all of them (duplicate fan-out).
    const items =
      waitMs > 0 ? await deps.mirror.waitForInjections(waitMs) : deps.mirror.takeInjections()
    sendJson(res, 200, items)
    return
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const body = (await readBody(req)) as { text?: string } | undefined
    const text = (body?.text ?? '').trim()
    if (!text) {
      sendJson(res, 400, { error: 'text is required' })
      return
    }
    deps.onUserActivity?.()
    const inj = deps.mirror.addInjection(text, 'api')
    sendJson(res, 200, { ok: true, id: inj.id })
    return
  }

  if (url.pathname === '/api/injections/pause' && req.method === 'POST') {
    const body = (await readBody(req)) as { paused?: boolean } | undefined
    const paused = body?.paused === true
    deps.mirror.setInjectionPaused(paused)
    sendJson(res, 200, { ok: true, paused })
    return
  }

  if (url.pathname === '/api/injections/requeue' && req.method === 'POST') {
    const body = (await readBody(req)) as { text?: string } | undefined
    const text = String(body?.text ?? '').trim()
    if (text) {
      deps.onUserActivity?.()
      deps.mirror.addInjection(text, 'api')
    }
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === '/api/injections/ack' && req.method === 'POST') {
    const body = (await readBody(req)) as { id?: string } | undefined
    if (body?.id) deps.mirror.ackInjection(String(body.id))
    sendJson(res, 200, { ok: true })
    return
  }

  sendJson(res, 404, { error: `not found: ${url.pathname}` })
}

async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  deps: HttpServerDeps
): Promise<void> {
  const server = new McpServer({ name: 'duplex', version: deps.version })
  for (const def of toolDefs) {
    if (def.internal) continue
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.input },
      async (args: Record<string, unknown>) => {
        const result = await deps.executeTool(def.name, args ?? {})
        return result as { content: Array<{ type: 'text'; text: string }> }
      }
    )
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  })
  res.on('close', () => {
    void transport.close().catch(() => undefined)
    void server.close().catch(() => undefined)
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}
