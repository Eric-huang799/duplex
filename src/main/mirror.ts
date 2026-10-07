import type { Injection, MirrorEvent } from '../shared/protocol'

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

export type MirrorPush = DistributiveOmit<MirrorEvent, 'id' | 'ts'>

/** Single source of truth for mirrored AI conversation events and outbound injections. */
export class MirrorStore {
  private events: MirrorEvent[] = []
  private nextId = 1
  private injections: Injection[] = []
  private maxEvents = 1000
  private injectionWaiters = new Set<() => void>()
  private injectionPaused = false
  private lastConsumerAt = 0

  onEvent: ((ev: MirrorEvent) => void) | null = null

  /**
   * While paused, plugin long-polls are held off so automated tests can
   * consume the queue themselves without polluting real opencode sessions.
   */
  setInjectionPaused(paused: boolean): void {
    this.injectionPaused = paused
  }

  /**
   * Record the most recent activity from an AI consumer (an opencode plugin
   * polling /api/injections). Used by chat:send to warn when nothing is
   * connected to receive queued messages.
   */
  touchConsumer(): void {
    this.lastConsumerAt = Date.now()
  }

  hasConsumer(withinMs = 45000): boolean {
    return this.lastConsumerAt > 0 && Date.now() - this.lastConsumerAt <= withinMs
  }

  /**
   * Stream identity of an event: kind + sessionID + partID. Only events that
   * share this identity with the last accepted copy are candidates for
   * snapshot dedup; identical text under a different partID is a distinct
   * message and must never be dropped.
   */
  private streamKey(push: MirrorPush): string {
    const p = push as Record<string, unknown>
    return JSON.stringify([push.kind, p.sessionID ?? '', p.partID ?? ''])
  }

  private recentSigs = new Map<string, { sig: string; ts: number }>()

  add(push: MirrorPush): MirrorEvent | null {
    // Cross-instance / reconnect dedup: an exact repeat of the last content
    // for the same stream (opencode may deliver the same snapshot through
    // several plugin instances and the hook + SSE paths at once) is dropped.
    // A changed snapshot (same part, new content) passes through so the
    // renderer can merge the streaming update by partID.
    const key = this.streamKey(push)
    const sig = JSON.stringify(push)
    const now = Date.now()
    const prev = this.recentSigs.get(key)
    if (prev !== undefined && prev.sig === sig && now - prev.ts < 5000) return null
    this.recentSigs.set(key, { sig, ts: now })
    if (this.recentSigs.size > 3000) {
      const cutoff = now - 30_000
      for (const [k, v] of this.recentSigs) {
        if (v.ts < cutoff) this.recentSigs.delete(k)
      }
    }

    const ev = { ...push, id: this.nextId++, ts: Date.now() } as MirrorEvent
    this.events.push(ev)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
    }
    try {
      this.onEvent?.(ev)
    } catch {
      /* renderer may be gone */
    }
    return ev
  }

  snapshot(): MirrorEvent[] {
    return this.events.slice()
  }

  clear(): void {
    this.events = []
  }

  addInjection(text: string, source: Injection['source']): Injection {
    const inj: Injection = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      createdAt: Date.now(),
      source
    }
    this.injections.push(inj)
    if (this.injections.length > 100) {
      const dropped = this.injections.shift()
      console.error(
        `[mirror] injection queue overflow: dropped oldest injection ${dropped?.id ?? ''} (${dropped?.source ?? 'unknown'})`
      )
    }
    // wake long-poll waiters so delivery is near-instant — but NOT while
    // paused: already-suspended plugin polls must not pick test messages up
    if (!this.injectionPaused) {
      for (const wake of [...this.injectionWaiters]) wake()
    }
    return inj
  }

  pendingInjections(): Injection[] {
    return this.injections.slice()
  }

  ackInjection(id: string): void {
    this.injections = this.injections.filter((i) => i.id !== id)
  }

  /**
   * Atomically take all pending injections. Multiple plugin instances may be
   * long-polling at once — taking (instead of peeking) guarantees each message
   * is delivered to exactly one of them.
   */
  takeInjections(): Injection[] {
    const items = this.injections.slice()
    this.injections = []
    return items
  }

  /** Emergency stop: drop every pending send that has not been delivered yet. */
  clearInjections(): number {
    const n = this.injections.length
    this.injections = []
    return n
  }

  /**
   * Long-poll: resolve immediately when pending items exist, otherwise as soon
   * as an injection arrives (or with [] on timeout). Items are TAKEN (removed)
   * so exactly one waiter receives each message.
   */
  waitForInjections(timeoutMs: number): Promise<Injection[]> {
    if (this.injectionPaused) {
      return new Promise((resolve) => {
        setTimeout(() => resolve([]), timeoutMs)
      })
    }
    if (this.injections.length > 0) return Promise.resolve(this.takeInjections())
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (items: Injection[]): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.injectionWaiters.delete(wake)
        resolve(items)
      }
      const wake = (): void => finish(this.takeInjections())
      timer = setTimeout(() => finish([]), timeoutMs)
      this.injectionWaiters.add(wake)
    })
  }
}
