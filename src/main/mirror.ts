import type { Injection, MirrorEvent } from '../shared/protocol'

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

export type MirrorPush = DistributiveOmit<MirrorEvent, 'id' | 'ts'>

export interface InjectionConsumer {
  id?: string
  sessionID?: string | null
}

export interface InjectionTarget {
  sessionID?: string | null
  consumerID?: string
}

const INJECTION_LEASE_MS = 60_000

/** Single source of truth for mirrored AI conversation events and outbound injections. */
export class MirrorStore {
  private events: MirrorEvent[] = []
  private nextId = 1
  private injections: Injection[] = []
  private inFlight = new Map<string, {
    injection: Injection
    consumerID?: string
    timer: ReturnType<typeof setTimeout>
  }>()
  private injectionGeneration = 0
  private maxEvents = 1000
  private injectionWaiters = new Set<() => void>()
  private injectionPaused = false
  private lastConsumerAt = 0

  onEvent: ((ev: MirrorEvent) => void) | null = null

  /** Pausing blocks every delivery path, including already waiting polls. */
  setInjectionPaused(paused: boolean): void {
    this.injectionPaused = paused
    if (!paused) this.wakeInjectionWaiters()
  }

  private wakeInjectionWaiters(): void {
    for (const wake of [...this.injectionWaiters]) wake()
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

  addInjection(text: string, source: Injection['source'], target?: InjectionTarget): Injection {
    const inj: Injection = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      createdAt: Date.now(),
      source,
      generation: this.injectionGeneration,
      ...(target?.sessionID !== undefined ? { targetSessionID: target.sessionID } : {}),
      ...(target?.consumerID ? { consumerID: target.consumerID } : {})
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
      this.wakeInjectionWaiters()
    }
    return inj
  }

  pendingInjections(): Injection[] {
    return this.injections.slice()
  }

  ackInjection(id: string, consumerID?: string): boolean {
    const claimed = this.inFlight.get(id)
    if (claimed) {
      if (claimed.consumerID !== consumerID) return false
      clearTimeout(claimed.timer)
      this.inFlight.delete(id)
      this.wakeInjectionWaiters()
      return true
    }
    // Keep the local pre-claim acknowledgment API used by existing callers.
    if (consumerID !== undefined) return false
    const index = this.injections.findIndex((i) => i.id === id)
    if (index < 0) return false
    this.injections.splice(index, 1)
    return true
  }

  /** A slow but live recipient keeps its unacknowledged message from being redelivered. */
  renewInjection(id: string, consumerID?: string): boolean {
    const claimed = this.inFlight.get(id)
    if (!claimed || claimed.consumerID !== consumerID ||
      claimed.injection.generation !== this.injectionGeneration) return false
    clearTimeout(claimed.timer)
    claimed.timer = this.injectionLeaseTimer(id, consumerID)
    return true
  }

  /** Reconnect changes the consumer identity, never the selected message session. */
  rebindConsumer(sessionID: string, consumerID: string): number {
    if (!sessionID || !consumerID) return 0
    let rebound = 0
    for (const injection of [
      ...this.injections, ...[...this.inFlight.values()].map((c) => c.injection)
    ]) {
      if (injection.targetSessionID === sessionID && injection.consumerID !== consumerID) {
        injection.consumerID = consumerID
        rebound++
      }
    }
    if (rebound && !this.injectionPaused) this.wakeInjectionWaiters()
    return rebound
  }

  private injectionLeaseTimer(id: string, consumerID?: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.releaseInjection(id, consumerID), INJECTION_LEASE_MS)
    timer.unref?.()
    return timer
  }

  /** Return a claimed message to the queue without changing its identity or target. */
  releaseInjection(id: string, consumerID?: string): boolean {
    const claimed = this.inFlight.get(id)
    if (!claimed || claimed.consumerID !== consumerID) return false
    clearTimeout(claimed.timer)
    this.inFlight.delete(id)
    if (claimed.injection.generation !== this.injectionGeneration) return false
    this.injections.unshift(claimed.injection)
    if (!this.injectionPaused) this.wakeInjectionWaiters()
    return true
  }

  /** Claim one matching message. It remains owned until acknowledgment or lease expiry. */
  takeInjections(consumer?: InjectionConsumer): Injection[] {
    if (this.injectionPaused) return []
    const index = this.injections.findIndex((i) => {
      if (i.consumerID && i.consumerID !== consumer?.id) return false
      if (i.targetSessionID && i.targetSessionID !== consumer?.sessionID) return false
      // Preserve the order within a session while an earlier message is unconfirmed.
      return ![...this.inFlight.values()].some((c) =>
        (consumer?.id && c.consumerID === consumer.id) ||
        (i.targetSessionID && c.injection.targetSessionID === i.targetSessionID)
      )
    })
    if (index < 0) return []
    const [injection] = this.injections.splice(index, 1)
    if (!injection.targetSessionID && consumer?.sessionID) {
      injection.targetSessionID = consumer.sessionID
    }
    const timer = this.injectionLeaseTimer(injection.id, consumer?.id)
    this.inFlight.set(injection.id, { injection, consumerID: consumer?.id, timer })
    return [{ ...injection }]
  }

  /** Emergency stop: drop every pending send that has not been delivered yet. */
  clearInjections(): number {
    const n = this.injections.length + this.inFlight.size
    this.injections = []
    for (const claimed of this.inFlight.values()) clearTimeout(claimed.timer)
    this.inFlight.clear()
    this.injectionGeneration++
    this.wakeInjectionWaiters()
    return n
  }

  /**
   * Long-poll: resolve immediately when pending items exist, otherwise as soon
   * as a matching injection arrives (or with [] on timeout). Claimed messages
   * remain in flight so failed or disconnected recipients cannot lose them.
   */
  waitForInjections(timeoutMs: number, consumer?: InjectionConsumer): Promise<Injection[]> {
    const items = this.takeInjections(consumer)
    if (items.length > 0) return Promise.resolve(items)
    const generation = this.injectionGeneration
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
      const wake = (): void => {
        if (generation !== this.injectionGeneration) return finish([])
        const ready = this.takeInjections(consumer)
        if (ready.length > 0) finish(ready)
      }
      timer = setTimeout(() => finish([]), timeoutMs)
      this.injectionWaiters.add(wake)
    })
  }
}
