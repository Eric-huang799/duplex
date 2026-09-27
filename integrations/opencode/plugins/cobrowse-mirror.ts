/**
 * CoBrowse mirror plugin for opencode.
 *
 * Install (project level): copy this file to <your-project>/.opencode/plugins/cobrowse-mirror.ts
 *
 * One component, two directions:
 *  - Mirror: opencode session events (assistant text, tool calls, session state)
 *    are pushed to the CoBrowse browser, which shows them in its right panel.
 *  - Inject: messages typed in the browser panel (and page annotations) are
 *    pulled from CoBrowse via LONG-POLL (near-instant delivery, no 2s ticks)
 *    and sent into the most recently active opencode session via promptAsync
 *    (returns immediately, so a slow AI response never blocks later messages).
 *
 * Zero npm dependencies (Bun/Node builtins + fetch only).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ENDPOINT_FILE = path.join(os.homedir(), '.cobrowse', 'endpoint.json')
const FLUSH_INTERVAL_MS = 2500
const INJECTION_WAIT_MS = 20000
const RETRY_DELAY_MS = 2000
const MAX_BUFFER = 800
const MAX_BATCH = 40

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Endpoint {
  port: number
  token: string
}

function readEndpoint(): Endpoint | null {
  try {
    const raw = fs.readFileSync(ENDPOINT_FILE, 'utf8')
    const j = JSON.parse(raw) as { port?: unknown; token?: unknown }
    if (typeof j.port === 'number' && typeof j.token === 'string' && j.token) {
      return { port: j.port, token: j.token }
    }
    return null
  } catch {
    return null
  }
}

export const CobrowseMirror = async (ctx: {
  client?: any
  directory?: string
}): Promise<{ event: (input: { event: any }) => Promise<void> }> => {
  const client = ctx?.client
  const projectDir = typeof ctx?.directory === 'string' ? ctx.directory : ''
  const buffer: any[] = []
  const roles = new Map<string, 'user' | 'assistant'>()
  let lastSessionID: string | null = null
  let flushing = false
  const seenEventTypes = new Set<string>()
  const seenPartTypes = new Set<string>()
  const lastPartSig = new Map<string, string>()
  let pushCount = 0
  const unwrap = (r: any): any => (r && typeof r === 'object' && 'data' in r ? r.data : r)

  const logIt = (level: string, message: string, extra?: unknown): void => {
    try {
      void client?.app?.log?.({
        body: { service: 'cobrowse-mirror', level, message, extra }
      })
    } catch {
      /* ignore */
    }
  }

  /**
   * Instances whose project folder no longer exists must NOT consume messages
   * or commands: their prompt calls fail with ENOENT (surfacing as a bogus
   * "session error" in the panel). They stay silent so healthy instances win.
   */
  const instanceHealthy = (): boolean => {
    if (!projectDir) return true
    try {
      return fs.existsSync(projectDir)
    } catch {
      return true
    }
  }

  // ---------------------------------------------------------------- mirror --

  const flush = async (): Promise<void> => {
    if (flushing || buffer.length === 0) return
    const ep = readEndpoint()
    if (!ep) return
    flushing = true
    try {
      const batch = buffer.slice(0, MAX_BATCH)
      const res = await fetch(`http://127.0.0.1:${ep.port}/api/mirror`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ep.token}`
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(4000)
      })
      if (res.ok) buffer.splice(0, batch.length)
    } catch {
      /* browser not running; retry on the next tick */
    } finally {
      flushing = false
    }
  }

  const push = (payload: Record<string, unknown>): void => {
    buffer.push(payload)
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
    pushCount++
    if (pushCount === 1 || pushCount % 50 === 0) {
      logIt('info', 'mirror events pushed', { total: pushCount, lastKind: payload.kind })
    }
    void flush()
  }

  const handlePart = (part: any, roleOverride?: 'user' | 'assistant'): void => {
    if (!part || typeof part !== 'object') return
    if (typeof part.type === 'string' && !seenPartTypes.has(part.type)) {
      seenPartTypes.add(part.type)
      logIt('info', 'first part of type', { partType: part.type })
    }
    const sessionID = String(part.sessionID ?? '')
    if (sessionID) lastSessionID = sessionID
    const base = {
      sessionID,
      messageID: String(part.messageID ?? ''),
      partID: String(part.id ?? '')
    }
    // signature dedup: guards SSE reconnect replays and multi-instance loads
    const sig = `${part.type}|${base.partID}|${part.text ?? ''}|${part.state?.status ?? ''}|${String(part.state?.output ?? '').length}`
    if (lastPartSig.get(base.partID) === sig) return
    lastPartSig.set(base.partID, sig)
    if (lastPartSig.size > 4000) {
      const keys = [...lastPartSig.keys()].slice(0, 2000)
      for (const k of keys) lastPartSig.delete(k)
    }

    if (part.type === 'text' && typeof part.text === 'string') {
      const role = roleOverride ?? roles.get(base.messageID) ?? 'assistant'
      if (roleOverride && base.messageID) roles.set(base.messageID, roleOverride)
      push({ kind: 'text', ...base, role, text: part.text, done: false })
    } else if (part.type === 'reasoning' && typeof part.text === 'string') {
      push({ kind: 'reasoning', ...base, text: part.text, done: false })
    } else if (part.type === 'tool') {
      const st = part.state ?? {}
      push({
        kind: 'tool',
        ...base,
        tool: String(part.tool ?? 'tool'),
        callID: String(part.callID ?? ''),
        status: String(st.status ?? 'pending'),
        title: typeof st.title === 'string' ? st.title : undefined,
        input: st.input,
        output: typeof st.output === 'string' ? st.output.slice(0, 4000) : undefined,
        error: typeof st.error === 'string' ? st.error.slice(0, 2000) : undefined
      })
    }
  }

  // --------------------------------------------------------------- inject --

  /** Push a session's stored history so the panel can show its context. */
  const pushHistory = async (sid: string): Promise<void> => {
    try {
      const raw = await client.session.messages({ path: { id: sid } })
      const list = unwrap(raw)
      if (!Array.isArray(list)) {
        logIt('warn', 'history fetch returned non-array', { sessionID: sid })
        return
      }
      const tail = list.slice(-80) // keep huge sessions from flooding the panel
      // allow re-loading the same parts when switching back and forth
      lastPartSig.clear()
      let parts = 0
      for (const m of tail) {
        const info = m?.info ?? {}
        const role: 'user' | 'assistant' = info.role === 'user' ? 'user' : 'assistant'
        const messageID = String(info.id ?? '')
        if (messageID) roles.set(messageID, role)
        for (const part of m?.parts ?? []) {
          handlePart(part, role)
          parts++
        }
      }
      logIt('info', 'session history pushed', { sessionID: sid, messages: tail.length, parts })
    } catch (e) {
      logIt('warn', 'history fetch failed', {
        sessionID: sid,
        error: (e as Error)?.message ?? String(e)
      })
    }
  }

  /** Authoritative session target lives in the main process (shared by all instances). */
  const fetchActiveSession = async (): Promise<string | null> => {
    const ep = readEndpoint()
    if (!ep) return null
    try {
      const res = await fetch(`http://127.0.0.1:${ep.port}/api/session/state`, {
        headers: { authorization: `Bearer ${ep.token}` },
        signal: AbortSignal.timeout(3000)
      })
      if (!res.ok) return null
      const st = (await res.json()) as { activeSessionID?: string | null }
      return st?.activeSessionID ? String(st.activeSessionID) : null
    } catch {
      return null
    }
  }

  /** Put a taken injection back when it could not be delivered. */
  const requeueInjection = async (text: string): Promise<void> => {
    const ep = readEndpoint()
    if (!ep) return
    try {
      await fetch(`http://127.0.0.1:${ep.port}/api/injections/requeue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(4000)
      })
    } catch {
      /* only lost if the browser itself is gone */
    }
  }

  const injectText = async (text: string, sid: string | null): Promise<boolean> => {
    if (!sid || !client?.session) return false
    const options = {
      path: { id: sid },
      body: { parts: [{ type: 'text', text }] }
    }
    try {
      if (typeof client.session.promptAsync === 'function') {
        // returns as soon as the message is queued (204) — later injections
        // are delivered even while the AI is still answering a previous one
        await client.session.promptAsync(options)
      } else {
        // fallback for older SDKs: fire-and-forget, never await the response
        void client.session.prompt(options).catch(() => undefined)
      }
      return true
    } catch (e) {
      logIt('warn', 'injection failed; will retry', {
        error: (e as Error)?.message ?? String(e)
      })
      return false
    }
  }

  /** Long-poll loop: the browser holds the request open until a message exists. */
  const pollLoop = async (): Promise<void> => {
    for (;;) {
      const ep = readEndpoint()
      if (!ep) {
        await sleep(2500)
        continue
      }
      if (!instanceHealthy()) {
        await sleep(10000)
        continue
      }
      try {
        const res = await fetch(
          `http://127.0.0.1:${ep.port}/api/injections?wait=${INJECTION_WAIT_MS}`,
          {
            headers: { authorization: `Bearer ${ep.token}` },
            signal: AbortSignal.timeout(INJECTION_WAIT_MS + 8000)
          }
        )
        if (!res.ok) {
          await sleep(RETRY_DELAY_MS)
          continue
        }
        const items = (await res.json()) as Array<{ id?: string; text?: string }>
        if (!Array.isArray(items) || items.length === 0) continue // timeout tick

        // Resolve the (shared, main-process authoritative) target once per batch.
        const activeSid = await fetchActiveSession()
        const sid = activeSid ?? lastSessionID

        if (!sid) {
          logIt('warn', 'browser message received but no session known yet; requeueing', {
            count: items.length
          })
          for (const item of items) {
            if (typeof item?.text === 'string') await requeueInjection(item.text)
          }
          await sleep(2000)
          continue
        }

        for (const item of items) {
          if (!item?.id || typeof item.text !== 'string') continue
          const ok = await injectText(item.text, sid)
          if (!ok) {
            logIt('warn', 'injection failed; requeueing', { id: item.id })
            await requeueInjection(item.text)
            await sleep(1500)
            break
          }
          await fetch(`http://127.0.0.1:${ep.port}/api/injections/ack`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${ep.token}`
            },
            body: JSON.stringify({ id: item.id }),
            signal: AbortSignal.timeout(4000)
          })
          logIt('info', 'browser message injected into session', {
            sessionID: sid,
            id: item.id
          })
        }
      } catch {
        await sleep(RETRY_DELAY_MS)
      }
    }
  }

  const handleEvent = (event: any): void => {
    try {
      if (!event || typeof event.type !== 'string') return
      if (!seenEventTypes.has(event.type)) {
        seenEventTypes.add(event.type)
        logIt('info', 'first event of type', { type: event.type })
      }
      const p = event.properties ?? {}

      if (event.type === 'message.updated') {
        const info = p.info
        if (info?.id && info?.role) {
          roles.set(String(info.id), info.role === 'user' ? 'user' : 'assistant')
        }
        if (info?.sessionID) lastSessionID = String(info.sessionID)
        return
      }

      if (event.type === 'message.part.updated') {
        handlePart(p.part)
        return
      }

      if (event.type === 'session.idle') {
        const sid = String(p.sessionID ?? lastSessionID ?? '')
        if (sid) push({ kind: 'session', sessionID: sid, status: 'idle' })
        return
      }

      if (event.type === 'session.error') {
        const sid = String(p.sessionID ?? lastSessionID ?? '')
        push({
          kind: 'session',
          sessionID: sid,
          status: 'error',
          error: p.error?.message ?? p.error?.name ?? 'unknown error'
        })
      }
    } catch {
      /* never break the session */
    }
  }

  /**
   * SSE event stream straight from the opencode server. The plugin `event`
   * hook is not invoked on the OpenCode desktop build, so the mirror relies on
   * this; the hook path (CLI builds) feeds the same handler, and duplicate
   * deliveries are deduped by part signature.
   */
  const eventStreamLoop = async (): Promise<void> => {
    for (;;) {
      if (!client?.event?.subscribe) {
        await sleep(3000)
        continue
      }
      try {
        const res: any = await client.event.subscribe()
        const stream = res?.stream ?? res?.data?.stream
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
          logIt('warn', 'event subscribe returned no stream', { keys: Object.keys(res ?? {}) })
          await sleep(3000)
          continue
        }
        logIt('info', 'event stream connected (SSE)')
        for await (const event of stream) handleEvent(event)
        logIt('warn', 'event stream ended; reconnecting')
      } catch (e) {
        logIt('warn', 'event stream error; reconnecting', {
          error: (e as Error)?.message ?? String(e)
        })
      }
      await sleep(2000)
    }
  }

  // ------------------------------------------------------- session select --

  const reportSessions = async (sessions: unknown[], reason: string): Promise<void> => {
    const ep = readEndpoint()
    if (!ep) return
    try {
      await fetch(`http://127.0.0.1:${ep.port}/api/session/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
        body: JSON.stringify({ sessions, reason }),
        signal: AbortSignal.timeout(4000)
      })
    } catch {
      /* browser not running */
    }
  }

  const reportCreated = async (id: string, title: string): Promise<void> => {
    const ep = readEndpoint()
    if (!ep) return
    try {
      await fetch(`http://127.0.0.1:${ep.port}/api/session/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
        body: JSON.stringify({ activeSessionID: id, activeTitle: title, reason: 'created' }),
        signal: AbortSignal.timeout(4000)
      })
    } catch {
      /* browser not running */
    }
  }

  const fetchSessionList = async (): Promise<
    Array<{ id: string; title: string; updated: number }>
  > => {
    const raw = await client.session.list()
    const list = unwrap(raw)
    if (!Array.isArray(list)) return []
    return list
      .slice()
      .sort((a: any, b: any) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0))
      .slice(0, 25)
      .map((s: any) => ({
        id: String(s?.id ?? ''),
        title: String(s?.title ?? '(无标题)'),
        updated: Number(s?.time?.updated ?? 0)
      }))
  }

  /** Session control channel: pick an existing conversation or create one. */
  const sessionCommandLoop = async (): Promise<void> => {
    for (;;) {
      const ep = readEndpoint()
      if (!ep) {
        await sleep(2500)
        continue
      }
      if (!instanceHealthy()) {
        await sleep(10000)
        continue
      }
      try {
        const res = await fetch(`http://127.0.0.1:${ep.port}/api/session/command?wait=20000`, {
          headers: { authorization: `Bearer ${ep.token}` },
          signal: AbortSignal.timeout(26000)
        })
        if (!res.ok) {
          await sleep(2000)
          continue
        }
        const cmds = (await res.json()) as Array<{
          action?: string
          sessionID?: string | null
          title?: string
        }>
        if (!Array.isArray(cmds) || cmds.length === 0) continue
        for (const cmd of cmds) {
          try {
            if (cmd.action === 'list') {
              const sessions = await fetchSessionList()
              logIt('info', 'session list requested', { count: sessions.length })
              await reportSessions(sessions, 'listed')
            } else if (cmd.action === 'history') {
              const sid = cmd.sessionID ? String(cmd.sessionID) : ''
              if (sid) await pushHistory(sid)
            } else if (cmd.action === 'create') {
              const created = unwrap(
                await client.session.create({ body: { title: 'Duplex 对话' } })
              )
              const id = String(created?.id ?? '')
              if (id) {
                const title = String(created?.title ?? 'Duplex 对话')
                logIt('info', 'session created', { sessionID: id })
                await reportCreated(id, title)
              }
            }
          } catch (e) {
            logIt('warn', 'session command failed', {
              action: cmd?.action,
              error: (e as Error)?.message ?? String(e)
            })
          }
        }
      } catch {
        await sleep(2000)
      }
    }
  }

  setInterval(() => void flush(), FLUSH_INTERVAL_MS)
  void pollLoop()
  void eventStreamLoop()
  void sessionCommandLoop()
  logIt('info', 'cobrowse-mirror plugin loaded (SSE + long-poll + session select)')

  return {
    event: async ({ event }: { event: any }) => handleEvent(event)
  }
}
