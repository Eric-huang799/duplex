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
import { randomUUID } from 'node:crypto'

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
  const consumerID = `${process.pid}:${randomUUID()}`
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
  const requeueInjection = async (id: string): Promise<void> => {
    const ep = readEndpoint()
    if (!ep) return
    try {
      await fetch(`http://127.0.0.1:${ep.port}/api/injections/requeue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
        body: JSON.stringify({ id, consumerID }),
        signal: AbortSignal.timeout(4000)
      })
    } catch {
      /* The browser retains unacknowledged claims; lease expiry permits retry. */
    }
  }

  const renewInjection = async (id: string): Promise<boolean | null> => {
    const ep = readEndpoint()
    if (!ep) return null
    try {
      const response = await fetch(`http://127.0.0.1:${ep.port}/api/injections/renew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
        body: JSON.stringify({ id, consumerID }),
        signal: AbortSignal.timeout(4000)
      })
      if (!response.ok) return null
      return ((await response.json()) as { ok?: boolean }).ok === true
    } catch {
      return null
    }
  }

  const acknowledgeInjection = async (id: string): Promise<boolean> => {
    // Retrying the receipt is safe; retrying an accepted prompt could execute it twice.
    for (let attempt = 0; attempt < 3; attempt++) {
      const ep = readEndpoint()
      if (!ep) return false
      try {
        const response = await fetch(`http://127.0.0.1:${ep.port}/api/injections/ack`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
          body: JSON.stringify({ id, consumerID }),
          signal: AbortSignal.timeout(4000)
        })
        if (!response.ok) throw new Error(`ack HTTP ${response.status}`)
        return ((await response.json()) as { ok?: boolean }).ok === true
      } catch {
        if (attempt < 2) await sleep(RETRY_DELAY_MS)
      }
    }
    return false
  }

  /** A project/client must not remove another OpenCode server's messages. */
  const ownsSession = async (sid: string): Promise<boolean> => {
    const matchesProject = (session: any): boolean => {
      if (!projectDir || typeof session?.directory !== 'string') return true
      const normalize = (dir: string): string => {
        const resolved = path.resolve(dir)
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved
      }
      return normalize(session.directory) === normalize(projectDir)
    }
    try {
      if (typeof client?.session?.get === 'function') {
        const result = unwrap(await client.session.get({ path: { id: sid } }))
        return String(result?.id ?? '') === sid && matchesProject(result)
      }
      if (typeof client?.session?.list === 'function') {
        const sessions = unwrap(await client.session.list())
        return Array.isArray(sessions) && sessions.some((s: any) => String(s?.id ?? '') === sid && matchesProject(s))
      }
    } catch {
      /* Not owned by this client, or temporarily unavailable: leave it pending. */
    }
    return false
  }

  const injectText = async (text: string, sid: string | null): Promise<boolean> => {
    if (!sid || !client?.session) return false
    const options = {
      path: { id: sid },
      body: { parts: [{ type: 'text', text }] }
    }
    try {
      let result: any
      if (typeof client.session.promptAsync === 'function') {
        // returns as soon as the message is queued (204) — later injections
        // are delivered even while the AI is still answering a previous one
        result = await client.session.promptAsync(options)
      } else {
        // Older SDKs expose only the full prompt call. Keep the claim until it
        // resolves instead of acknowledging a request that could still reject.
        result = await client.session.prompt(options)
      }
      if (result?.error) throw new Error(String(result.error.message ?? 'prompt rejected'))
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
        // Capture and validate the target BEFORE claiming a message. A later
        // browser selection must not redirect a message already received.
        const activeSid = await fetchActiveSession()
        const sid = activeSid ?? lastSessionID
        if (!sid || !(await ownsSession(sid))) {
          await sleep(RETRY_DELAY_MS)
          continue
        }
        const query = new URLSearchParams({
          wait: String(INJECTION_WAIT_MS), consumerID, sessionID: sid
        })
        const res = await fetch(
          `http://127.0.0.1:${ep.port}/api/injections?${query}`,
          {
            headers: { authorization: `Bearer ${ep.token}` },
            signal: AbortSignal.timeout(INJECTION_WAIT_MS + 8000)
          }
        )
        if (!res.ok) {
          await sleep(RETRY_DELAY_MS)
          continue
        }
        const items = (await res.json()) as Array<{
          id?: string; text?: string; targetSessionID?: string | null
        }>
        if (!Array.isArray(items) || items.length === 0) continue // timeout tick
        for (let index = 0; index < items.length; index++) {
          const item = items[index]
          if (!item?.id) continue
          const targetSid = item.targetSessionID ?? sid
          // Validate the claim immediately before acceptance, then keep it alive
          // while older SDKs wait for the complete answer instead of promptAsync.
          let canceled = false
          let renewing = false
          const renewTimer = setInterval(() => {
            if (renewing || canceled) return
            renewing = true
            void renewInjection(item.id!).then((valid) => {
              if (valid === false) canceled = true
            }).finally(() => { renewing = false })
          }, 20_000)
          renewTimer.unref?.()
          let ok = false
          try {
            ok = typeof item.text === 'string' && targetSid === sid &&
              await renewInjection(item.id) === true &&
              await injectText(item.text, targetSid)
          } finally {
            clearInterval(renewTimer)
          }
          if (canceled) ok = false
          if (!ok) {
            logIt('warn', 'injection failed; requeueing', { id: item.id })
            // The current server returns one claim, but retain compatibility
            // with earlier batches: release every unsent item, in reverse order
            // because release restores each original item at the queue front.
            for (let remaining = items.length - 1; remaining >= index; remaining--) {
              const pendingID = items[remaining]?.id
              if (pendingID) await requeueInjection(pendingID)
            }
            await sleep(1500)
            break
          }
          if (!(await acknowledgeInjection(item.id))) {
            // Do not release the accepted prompt: its ACK may have reached the
            // server. The lease handles that uncertain outcome. Preserve unsent
            // items rather than abandoning the rest of an older server batch.
            for (let remaining = items.length - 1; remaining > index; remaining--) {
              const pendingID = items[remaining]?.id
              if (pendingID) await requeueInjection(pendingID)
            }
            await sleep(RETRY_DELAY_MS)
            break
          }
          logIt('info', 'browser message injected into session', {
            sessionID: targetSid,
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
        body: JSON.stringify({ sessions, reason, consumerID }),
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
        body: JSON.stringify({ activeSessionID: id, activeTitle: title, reason: 'created', consumerID }),
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
        const res = await fetch(`http://127.0.0.1:${ep.port}/api/session/command?wait=20000&consumerID=${encodeURIComponent(consumerID)}`, {
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
          consumerID?: string
        }>
        if (!Array.isArray(cmds) || cmds.length === 0) continue
        for (const cmd of cmds) {
          try {
            if (cmd.consumerID && cmd.consumerID !== consumerID) continue
            if (cmd.action === 'list') {
              const sessions = await fetchSessionList()
              logIt('info', 'session list requested', { count: sessions.length })
              await reportSessions(sessions, 'listed')
            } else if (cmd.action === 'history') {
              const sid = cmd.sessionID ? String(cmd.sessionID) : ''
              if (sid && await ownsSession(sid)) await pushHistory(sid)
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
