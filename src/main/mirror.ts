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

  onEvent: ((ev: MirrorEvent) => void) | null = null

  /**
   * While paused, plugin long-polls are held off so automated tests can
   * consume the queue themselves without polluting real opencode sessions.
   */
  setInjectionPaused(paused: boolean): void {
    this.injectionPaused = paused
  }
  private recentSigs = new Map<string, number>()

  add(push: MirrorPush): MirrorEvent | null {
    // Cross-instance / reconnect dedup: identical event content within 5s is
    // dropped (opencode may deliver the same event through several plugin
    // instances and the hook + SSE paths at once).
    const p = push as Record<string, unknown>
    const sig = JSON.stringify([
      push.kind,
      p.sessionID ?? '',
      p.partID ?? '',
      p.annotationId ?? '',
      p.text ?? '',
      p.status ?? '',
      p.tool ?? '',
      p.tool === undefined && p.status === undefined ? p.summary ?? '' : ''
    ])
    const now = Date.now()
    const prev = this.recentSigs.get(sig)
    if (prev !== undefined && now - prev < 5000) return null
    this.recentSigs.set(sig, now)
    if (this.recentSigs.size > 3000) {
      const cutoff = now - 30_000
      for (const [key, ts] of this.recentSigs) {
        if (ts < cutoff) this.recentSigs.delete(key)
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
    if (this.injections.length > 100) this.injections.shift()
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
