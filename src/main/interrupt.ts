/**
 * Interruptible operations.
 *
 * Each tool execution runs inside its own AbortController context
 * (AsyncLocalStorage), so concurrent tool calls never abort each other.
 * The overlay Esc handler (or status-bar click) aborts ALL in-flight
 * operations immediately so long waits (page loads, sleeps) end right away.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const als = new AsyncLocalStorage<AbortController>()
const active = new Set<AbortController>()

export function beginOperation(): AbortController {
  const ac = new AbortController()
  active.add(ac)
  return ac
}

export function endOperation(ac: AbortController): void {
  active.delete(ac)
}

export function runInOperation<T>(ac: AbortController, fn: () => Promise<T>): Promise<T> {
  return als.run(ac, fn)
}

/** Returns true when at least one in-flight operation was actually aborted. */
export function abortOperation(): boolean {
  let any = false
  for (const ac of active) {
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
