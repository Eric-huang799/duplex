/**
 * Interruptible operations.
 *
 * Each tool execution runs inside its own AbortController context
 * (AsyncLocalStorage), so concurrent tool calls never abort each other.
 * The emergency stop (takeover) aborts ALL in-flight operations immediately
 * so long waits (page loads, sleeps) end right away.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const als = new AsyncLocalStorage<AbortController>()
const active = new Map<AbortController, { owner?: string; tabId?: number; mutates?: boolean }>()

export function beginOperation(meta: { owner?: string; tabId?: number; mutates?: boolean } = {}): AbortController {
  const ac = new AbortController()
  active.set(ac, meta)
  return ac
}

export function endOperation(ac: AbortController): void {
  active.delete(ac)
}

export function runInOperation<T>(ac: AbortController, fn: () => Promise<T>): Promise<T> {
  return als.run(ac, fn)
}

/** Returns true when at least one in-flight operation was actually aborted. */
export function abortOperation(filter?: { owner?: string; tabId?: number; writesOnly?: boolean }): boolean {
  let any = false
  for (const [ac, meta] of active) {
    if (filter?.owner != null && meta.owner !== filter.owner) continue
    if (filter?.tabId != null && meta.tabId !== filter.tabId) continue
    if (filter?.writesOnly && meta.mutates !== true) continue
    if (!ac.signal.aborted) {
      ac.abort()
      any = true
    }
  }
  return any
}

/** The current operation's signal (per async context), aborted or not; null outside an operation. */
export function operationSignal(): AbortSignal | null {
  const ac = als.getStore()
  return ac ? ac.signal : null
}

/** Sleep that ends early when the current operation is aborted. */
export function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const signal = operationSignal()
    if (!signal) {
      setTimeout(resolve, ms)
      return
    }
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Await a promise but give up (resolving `fallback`) the moment the current
 * operation is aborted — used for user-confirmation dialogs and other waits
 * that must not keep the emergency stop hanging.
 */
export function interruptibleAwait<T>(p: Promise<T>, fallback: T): Promise<T> {
  const signal = operationSignal()
  if (!signal) return p
  if (signal.aborted) return Promise.resolve(fallback)
  return new Promise<T>((resolve) => {
    let settled = false
    const finish = (v: T): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(v)
    }
    const onAbort = (): void => finish(fallback)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then((v) => finish(v)).catch(() => finish(fallback))
  })
}
