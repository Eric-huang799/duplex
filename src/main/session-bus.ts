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
}

export interface QueuedSessionCommand extends SessionCommand {
  id: string
  createdAt: number
}

export interface SessionState {
  activeSessionID: string | null
  activeTitle: string | null
  sessions: SessionSummary[]
}

export class SessionBus {
  private queue: QueuedSessionCommand[] = []
  private waiters = new Set<() => void>()

  state: SessionState = {
    activeSessionID: null,
    activeTitle: null,
    sessions: []
  }

  push(cmd: SessionCommand): void {
    this.queue.push({
      ...cmd,
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

  private take(): QueuedSessionCommand[] {
    const items = this.queue.slice()
    this.queue = []
    return items
  }

  /** Long-poll for the plugin: resolves as soon as a command exists. */
  waitForCommands(timeoutMs: number): Promise<QueuedSessionCommand[]> {
    if (this.queue.length > 0) return Promise.resolve(this.take())
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
      const wake = (): void => finish(this.take())
      timer = setTimeout(() => finish([]), timeoutMs)
      this.waiters.add(wake)
    })
  }

  /** Browser picked a session (or null = auto follow). Authoritative here. */
  select(input: { sessionID: string | null; title?: string }): void {
    this.state.activeSessionID = input.sessionID ? String(input.sessionID) : null
    this.state.activeTitle = this.state.activeSessionID ? String(input.title ?? '') || null : null
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
  }): void {
    if ('activeSessionID' in input || 'activeTitle' in input) {
      this.state.activeSessionID = input.activeSessionID ?? null
      this.state.activeTitle = input.activeTitle ?? null
    }
    if (Array.isArray(input.sessions)) this.state.sessions = input.sessions
  }
}
