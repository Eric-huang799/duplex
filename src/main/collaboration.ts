import { AsyncLocalStorage } from 'node:async_hooks'
import type { CollaborationState, CollaborationTabState } from '../shared/protocol'

interface CallerContext { id: string }
const callers = new AsyncLocalStorage<CallerContext>()

export function withCaller<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return callers.run({ id }, fn)
}
export function currentCaller(): string { return callers.getStore()?.id ?? 'direct' }

export const PAGE_READ_TOOLS = new Set(['list_tabs', 'snapshot', 'query', 'get_html', 'screenshot', 'get_console', 'wait'])

interface TabState { owner: string | null; paused: boolean; reason: string | null; scrollingUntil: number }

/** Task identity and human intervention belong to the tab, independently of which tab is visible. */
export class CollaborationCoordinator {
  private bindings = new Map<string, number>()
  private states = new Map<number, TabState>()
  private tails = new Map<number, Promise<unknown>>()
  private scrollTimer: ReturnType<typeof setTimeout> | null = null
  onChanged: ((state: CollaborationState) => void) | null = null

  private state(tabId: number): TabState {
    let state = this.states.get(tabId)
    if (!state) { state = { owner: null, paused: false, reason: null, scrollingUntil: 0 }; this.states.set(tabId, state) }
    return state
  }
  private changed(): void { this.onChanged?.(this.snapshot()) }

  resolveTab(caller: string, explicit: number | undefined, active: number | null): number {
    const tabId = explicit ?? this.bindings.get(caller) ?? active
    if (tabId == null) throw new Error('没有任务标签，请先打开页面')
    this.bindings.set(caller, tabId)
    return tabId
  }
  bind(caller: string, tabId: number): void { this.bindings.set(caller, tabId) }
  boundTab(caller: string): number | undefined { return this.bindings.get(caller) }
  hasTask(tabId: number): boolean { return [...this.bindings.values()].includes(tabId) }
  release(caller: string): void {
    this.bindings.delete(caller)
    for (const state of this.states.values()) if (state.owner === caller) state.owner = null
    this.changed()
  }
  forget(tabId: number): void {
    this.states.delete(tabId)
    // Keep task bindings so closing its page cannot redirect the next operation.
    this.changed()
  }
  humanActivity(tabId: number, activity: string): void {
    const state = this.state(tabId)
    if (activity === 'scroll') {
      state.scrollingUntil = Date.now() + 900
      if (this.scrollTimer) clearTimeout(this.scrollTimer)
      this.scrollTimer = setTimeout(() => { this.scrollTimer = null; this.changed() }, 950)
      this.scrollTimer.unref?.()
    } else {
      state.paused = true
      state.reason = activity === 'annotation' ? '人工标注中' : activity === 'navigate' ? '人工已导航，需要重新观察' : '人工正在操作页面'
    }
    this.changed()
  }
  resume(tabId: number, resetOwner = true): void {
    const state = this.state(tabId)
    state.paused = false; state.reason = null; if (resetOwner) state.owner = null
    this.changed()
  }
  snapshot(): CollaborationState {
    const now = Date.now()
    return { tabs: [...this.states].map(([tabId, s]): CollaborationTabState => ({ tabId, owner: s.owner, paused: s.paused, reason: s.reason, scrolling: now < s.scrollingUntil })) }
  }
  async run<T>(tabId: number, caller: string, mutates: boolean, fn: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
    const check = (): void => {
      if (signal?.aborted) throw new Error('任务已取消')
      const state = this.state(tabId)
      if (mutates && state.paused) throw new Error(`${state.reason}；请由用户恢复此标签的 AI 操作。读取可继续。`)
      if (mutates && state.owner && state.owner !== caller) throw new Error('此标签正由其他 AI 任务操作；请使用独立标签，或由用户恢复后交接。')
    }
    check()
    if (!mutates) return fn()
    const run = (this.tails.get(tabId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      check()
      this.state(tabId).owner = caller
      this.changed()
      return fn()
    })
    this.tails.set(tabId, run)
    try { return await run } finally { if (this.tails.get(tabId) === run) this.tails.delete(tabId) }
  }
}
