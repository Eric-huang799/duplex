/**
 * 设计/协作可视化层的对外入口。
 *
 * 在 overlay 页面（shadow 内部之外）的 window 上暴露：
 *
 * ```ts
 * window.__duplexOverlayDesign = {
 *   cursors: CursorLayer,          // 多 agent 光标
 *   loupe:   { toggle(on?) },      // M 放大镜
 *   locator: { begin, end, onPick },// L 定位 / R 测量
 *   measure: { clear }             // 清掉已完成的测量
 * }
 * ```
 *
 * 主进程复用现有 `overlay:cmd` 通道发送 `{ kind: 'cursor', actor, state, x, y }`，
 * `index.ts` 收到后转给 `applyCursorCommand`；这里不改动任何既有消息的语义。
 *
 * 三个模式（放大镜 / 定位 / 测量）互斥；M / L / R 切换，Esc 全部退出。
 */
import { createCursorLayer } from './cursor-layer'
import type { CursorLayer, CursorState } from './cursor-layer'
import { createLoupe } from './loupe'
import type { Loupe } from './loupe'
import { createLocator } from './locator'
import type { Locator, LocatorKind, LocatorPick } from './locator'
import { isCursorState } from './design-utils'

export interface DesignOverlayApi {
  cursors: CursorLayer
  loupe: { toggle(on?: boolean): void }
  locator: {
    begin(kind: 'locate' | 'measure'): void
    end(): void
    onPick(cb: (pick: LocatorPick) => void): void
  }
  measure: { clear(): void }
}

/** 主进程 cursor 指令的最小形状；未知字段一律忽略，不信任外部输入。 */
export interface CursorCommand {
  kind: 'cursor'
  actor?: unknown
  state?: unknown
  x?: unknown
  y?: unknown
  durationMs?: unknown
}

interface DesignOverlayWindow extends Window {
  __duplexOverlayDesign?: DesignOverlayApi
}

let current: DesignOverlayApi | null = null
let teardown: (() => void) | null = null

function isEditableTarget(event: Event): boolean {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  const target = (path[0] ?? event.target) as HTMLElement | null
  if (!target) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable === true
  )
}

/** 安装设计层并挂到 window 上；重复调用返回同一个实例。 */
export function installDesignOverlay(): DesignOverlayApi | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  const win = window as DesignOverlayWindow
  if (win.__duplexOverlayDesign) {
    current = win.__duplexOverlayDesign
    return current
  }

  const cursors = createCursorLayer()
  const loupe: Loupe = createLoupe()
  const locator: Locator = createLocator()

  function beginLocator(kind: LocatorKind): void {
    if (kind !== 'locate' && kind !== 'measure') return
    if (loupe.isOpen()) loupe.hide()
    locator.begin(kind)
  }

  function toggleLoupe(on?: boolean): void {
    const next = on === undefined ? !loupe.isOpen() : !!on
    if (next) locator.end()
    loupe.toggle(next)
  }

  const api: DesignOverlayApi = {
    cursors,
    loupe: { toggle: toggleLoupe },
    locator: {
      begin: beginLocator,
      end: () => locator.end(),
      onPick: (cb: (pick: LocatorPick) => void): void => {
        locator.onPick(cb)
      }
    },
    measure: {
      clear: () => locator.clearMeasurements()
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
    if (event.isComposing) return
    if (isEditableTarget(event)) return
    const key = event.key.toLowerCase()
    if (key === 'm') {
      event.preventDefault()
      event.stopPropagation()
      toggleLoupe()
    } else if (key === 'l') {
      event.preventDefault()
      event.stopPropagation()
      beginLocator('locate')
    } else if (key === 'r') {
      event.preventDefault()
      event.stopPropagation()
      beginLocator('measure')
    } else if (key === 'escape') {
      if (locator.isActive() || loupe.isOpen()) {
        event.preventDefault()
        event.stopPropagation()
        locator.end()
        loupe.hide()
      }
    }
  }

  const onPageHide = (): void => {
    // bfcache 里文档还活着：只退出模式，别销毁监听。
    locator.end()
    loupe.hide()
  }
  const onBeforeUnload = (): void => {
    destroyDesignOverlay()
  }

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('beforeunload', onBeforeUnload)

  teardown = (): void => {
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('beforeunload', onBeforeUnload)
    locator.destroy()
    loupe.destroy()
    cursors.destroy()
    if (win.__duplexOverlayDesign === api) delete win.__duplexOverlayDesign
    current = null
    teardown = null
  }

  win.__duplexOverlayDesign = api
  current = api
  return api
}

/** 当前已安装的 API（未安装时 null）。 */
export function designOverlayApi(): DesignOverlayApi | null {
  return current
}

/** 卸载：移除 host、window 属性与所有 window 级监听。幂等。 */
export function destroyDesignOverlay(): void {
  teardown?.()
}

/**
 * 处理主进程发来的 cursor 指令。
 * `state` 由调用方给出；x/y 只负责位置，`clicking` 额外产生 320ms 涟漪。
 */
export function applyCursorCommand(cmd: CursorCommand | null | undefined): void {
  const api =
    current ??
    (typeof window !== 'undefined'
      ? (window as DesignOverlayWindow).__duplexOverlayDesign
      : undefined)
  if (!api || !cmd || typeof cmd !== 'object') return

  const actor =
    typeof cmd.actor === 'string' && cmd.actor.trim().length > 0
      ? cmd.actor.trim().slice(0, 64)
      : 'agent'
  const state: CursorState | null = isCursorState(cmd.state) ? cmd.state : null
  const x = typeof cmd.x === 'number' && Number.isFinite(cmd.x) ? cmd.x : null
  const y = typeof cmd.y === 'number' && Number.isFinite(cmd.y) ? cmd.y : null
  const duration =
    typeof cmd.durationMs === 'number' && Number.isFinite(cmd.durationMs)
      ? cmd.durationMs
      : undefined

  if (state === 'clicking' && x !== null && y !== null) {
    // 先 click()（真实点击涟漪，并记录时间戳），再标记状态，避免两条涟漪。
    api.cursors.click(actor, x, y)
    api.cursors.setCursor(actor, 'clicking')
    return
  }
  if (state) api.cursors.setCursor(actor, state)
  if (x === null || y === null) return
  api.cursors.moveTo(actor, x, y, duration)
}
