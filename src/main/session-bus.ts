/**
 * Session bus: lets the browser panel pick which opencode session to talk to
 * (existing conversation or a newly created one).
 *
 * Browser/panel side pushes commands; the opencode plugin long-polls them and
 * reports back the active session + the session list.
 */
import type { SessionSummary } from '../shared/protocol'

export interface SessionCommand {
  action: 'list' | 'select' | 'create' | 'history'
  sessionID?: string | null
  title?: string
  consumerID?: string
}

export interface QueuedSessionCommand extends SessionCommand {
  id: string
  createdAt: number
}

export interface SessionState {
  activeSessionID: string | null
  activeTitle: string | null
  sessions: SessionSummary[]
  activeConsumerID?: string
}

export class SessionBus {
  private queue: QueuedSessionCommand[] = []
  private waiters = new Set<() => void>()
  private consumerSessions = new Map<string, SessionSummary[]>()

  private ownerOf(sessionID: string | null | undefined): string | undefined {
    if (!sessionID) return undefined
    for (const [consumerID, sessions] of this.consumerSessions) {
      if (sessions.some((s) => s.id === sessionID)) return consumerID
    }
    return undefined
  }

  state: SessionState = {
    activeSessionID: null,
    activeTitle: null,
    sessions: []
  }

  push(cmd: SessionCommand): void {
    const consumerID = cmd.consumerID ?? this.ownerOf(cmd.sessionID) ??
      (cmd.action === 'create' || cmd.sessionID === this.state.activeSessionID
        ? this.state.activeConsumerID : undefined)
    this.queue.push({
      ...cmd,
      ...(consumerID ? { consumerID } : {}),
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now()
    })
    if (this.queue.length > 20) {
      const dropped = this.queue.shift()
      console.error(
        `[session-bus] command queue overflow: dropped oldest command ${dropped?.id ?? ''} (${dropped?.action ?? ''})`
      )
    }
    for (const wake of [...this.waiters]) wake()
  }

  private take(consumerID?: string): QueuedSessionCommand[] {
    const items = this.queue.filter((cmd) => !cmd.consumerID || cmd.consumerID === consumerID)
    this.queue = this.queue.filter((cmd) => cmd.consumerID && cmd.consumerID !== consumerID)
    return items
  }

  /** Long-poll for the plugin: resolves as soon as a command exists. */
  waitForCommands(timeoutMs: number, consumerID?: string): Promise<QueuedSessionCommand[]> {
    const pending = this.take(consumerID)
    if (pending.length > 0) return Promise.resolve(pending)
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (items: QueuedSessionCommand[]): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.waiters.delete(wake)
        resolve(items)
      }
      const wake = (): void => {
        const items = this.take(consumerID)
        if (items.length > 0) finish(items)
      }
      timer = setTimeout(() => finish([]), timeoutMs)
      this.waiters.add(wake)
    })
  }

  /** Browser picked a session (or null = auto follow). Authoritative here. */
  select(input: { sessionID: string | null; title?: string }): void {
    this.state.activeSessionID = input.sessionID ? String(input.sessionID) : null
    this.state.activeTitle = this.state.activeSessionID ? String(input.title ?? '') || null : null
    this.state.activeConsumerID = this.ownerOf(this.state.activeSessionID)
  }

  /**
   * Plugin -> browser state report.
   * Active-session fields are only touched when explicitly present, so a
   * `list` report from any plugin instance can never reset the user's pick.
   */
  report(input: {
    activeSessionID?: string | null
    activeTitle?: string | null
    sessions?: SessionSummary[]
    reason?: string
    consumerID?: string
  }): void {
    if (input.consumerID && Array.isArray(input.sessions)) {
      const reportedIDs = new Set(input.sessions.map((s) => s.id))
      for (const [owner, sessions] of this.consumerSessions) {
        if (owner !== input.consumerID) {
          const retained = sessions.filter((s) => !reportedIDs.has(s.id))
          if (retained.length) this.consumerSessions.set(owner, retained)
          else this.consumerSessions.delete(owner)
        }
      }
      this.consumerSessions.set(input.consumerID, input.sessions)
      const merged = new Map<string, SessionSummary>()
      for (const sessions of this.consumerSessions.values()) {
        for (const session of sessions) merged.set(session.id, session)
      }
      this.state.sessions = [...merged.values()].sort((a, b) => b.updated - a.updated).slice(0, 100)
    } else if (Array.isArray(input.sessions)) {
      this.state.sessions = input.sessions
    }
    if ('activeSessionID' in input || 'activeTitle' in input) {
      this.state.activeSessionID = input.activeSessionID ?? null
      this.state.activeTitle = input.activeTitle ?? null
      this.state.activeConsumerID = this.state.activeSessionID
        ? input.consumerID ?? this.ownerOf(this.state.activeSessionID)
        : undefined
    } else if (this.state.activeSessionID) {
      this.state.activeConsumerID = this.ownerOf(this.state.activeSessionID) ?? this.state.activeConsumerID
    }
  }
}
