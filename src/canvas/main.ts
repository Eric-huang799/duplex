/**
 * 画布页面入口：连接宿主（没有就用演示宿主）、渲染文档、分发模式与快捷键。
 *
 * 这里**不**启动任何 Electron 逻辑：页面由主进程用 file:// 加载，
 * 所有跨进程通信都走 `window.canvasHost`（见 host.ts 的契约）。
 */

import { emptyDocument, type DesignDocument, type Rect } from '../shared/design/model'
import { on, setText, toRect } from './dom'
import {
  clampViewportWidth,
  cycleZoom,
  effectiveScale,
  formatPercent,
  screenRectToLayout
} from './geometry'
import {
  applyOpsToDom,
  getCanvasRender,
  renderDocument,
  type CanvasRender
} from './render'
import { createInteract, type CanvasMode } from './interact'
import { createInspector } from './inspector'
import { createToolbar } from './toolbar'
import { createVariants } from './variants'
import { createDemoHost, type DemoHost } from './demo'
import {
  readCanvasHost,
  type CanvasHost,
  type InboundMessage,
  type OutboundMessage
} from './host'

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`[canvas] 缺少必需的 DOM 节点：${selector}`)
  return element
}

function boot(): void {
  const stage = must<HTMLElement>('#stage')
  const page = must<HTMLElement>('#page')
  const pageBox = must<HTMLElement>('#page-box')
  const overlay = must<HTMLElement>('#overlay')
  const toolbarEl = must<HTMLElement>('#toolbar')
  const inspectorEl = must<HTMLElement>('#inspector')
  const variantsEl = must<HTMLElement>('#variants')
  const toastEl = must<HTMLElement>('#toast')
  const waitingEl = must<HTMLElement>('#canvas-waiting')

  let doc: DesignDocument = emptyDocument('等待设计文档', 'pending-doc')
  let render: CanvasRender | null = null
  let host: CanvasHost | null = null
  let demoHost: DemoHost | null = null
  let viewportWidth = doc.frame.width
  let zoom = 1
  let scale = 1
  let toastTimer = 0
  let resizeFrame = 0

  // ── 小工具 ──────────────────────────────────────────────────────────
  function toast(text: string): void {
    setText(toastEl, text)
    toastEl.hidden = false
    if (toastTimer) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toastEl.hidden = true
    }, 2800)
  }

  function send(message: OutboundMessage): void {
    if (!host) return
    try {
      host.send(message)
    } catch (error) {
      console.error('[canvas] 发送消息失败', message, error)
      toast(`发送消息失败：${(error as Error).message}`)
    }
  }

  /** 元素在**设计帧坐标系**下的包围盒（把画布缩放与页面原点换算掉）。 */
  function measureLayoutRect(id: string): Rect | null {
    if (!render) return null
    const element = render.get(id)
    if (!element) return null
    const pageOrigin = toRect(page.getBoundingClientRect())
    const clientRect = toRect(element.getBoundingClientRect())
    return screenRectToLayout(
      clientRect,
      { x: pageOrigin.x, y: pageOrigin.y },
      scale
    )
  }

  // ── 渲染与视口 ──────────────────────────────────────────────────────
  function applyViewport(commit: boolean): void {
    viewportWidth = clampViewportWidth(viewportWidth)
    const stageWidth = stage.clientWidth || window.innerWidth
    const nextScale = effectiveScale(viewportWidth, stageWidth, zoom)
    scale = nextScale

    pageBox.style.setProperty('--viewport-width', `${viewportWidth}px`)
    pageBox.style.setProperty('--canvas-scale', String(nextScale))
    // 帧坐标 → 预览坐标的缩放因子（render.ts 里 x/y/w/h 都乘它）
    pageBox.style.setProperty('--frame-scale', String(viewportWidth / doc.frame.width))

    // 页面高度 = max(根节点布局高度, 所有节点（含帧内绝对定位）的下边界)
    let contentBottom = page.offsetHeight
    if (render && nextScale > 0) {
      const origin = page.getBoundingClientRect()
      for (const element of render.list()) {
        const rect = element.getBoundingClientRect()
        const bottom = (rect.bottom - origin.top) / nextScale
        if (Number.isFinite(bottom) && bottom > contentBottom) contentBottom = bottom
      }
    }
    const pageHeight = Math.ceil(contentBottom)

    pageBox.style.width = `${Math.round(viewportWidth * nextScale)}px`
    pageBox.style.height = `${Math.round(pageHeight * nextScale)}px`

    toolbar.setViewport(viewportWidth, zoom, nextScale)
    interact.refresh()
    inspector.refresh()
    if (commit) send({ type: 'viewport', width: viewportWidth })
  }

  function setViewportWidth(width: number, commit: boolean): void {
    const next = clampViewportWidth(width)
    const changed = next !== viewportWidth
    viewportWidth = next
    applyViewport(commit && changed)
  }

  function cycleZoomAction(): void {
    zoom = cycleZoom(zoom)
    applyViewport(false)
    toast(`整体视图缩放 ${formatPercent(zoom)}`)
  }

  function mountDocument(next: DesignDocument): void {
    if (!next || typeof next !== 'object' || !next.root) {
      console.warn('[canvas] document 消息不完整，已忽略', next)
      return
    }
    doc = next
    waitingEl.hidden = true
    try {
      render = renderDocument(doc, page)
    } catch (error) {
      console.error('[canvas] 文档渲染失败', error)
      toast('文档渲染失败，详情见控制台')
      return
    }
    applyViewport(false)
    interact.refresh()
    inspector.refresh()
  }

  function applyPatchMessage(message: Extract<InboundMessage, { type: 'patch' }>): void {
    if (!Array.isArray(message.ops) || !message.doc) {
      console.warn('[canvas] patch 消息缺少 ops/doc，已忽略（契约要求两者都带）', message)
      return
    }
    doc = message.doc
    waitingEl.hidden = true
    try {
      applyOpsToDom(doc, message.ops, page)
      render = getCanvasRender(page) ?? render
    } catch (error) {
      console.error('[canvas] 增量应用失败，改为整页重渲', error)
      mountDocument(doc)
      return
    }
    applyViewport(false)
    interact.refresh()
    inspector.refresh()
  }

  function handleInbound(message: InboundMessage): void {
    if (!message || typeof message !== 'object') return
    switch (message.type) {
      case 'document':
        mountDocument(message.doc)
        break
      case 'patch':
        applyPatchMessage(message)
        break
      case 'variants':
        variants.show(message.blockId, Array.isArray(message.options) ? message.options : [])
        break
      case 'state':
        toolbar.setState({
          round: typeof message.round === 'number' ? message.round : null,
          dirty: message.dirty === true,
          actor: typeof message.actor === 'string' ? message.actor : null
        })
        break
      case 'cursor':
        interact.showRemoteCursor(message)
        break
      default:
        console.warn('[canvas] 未识别的宿主消息', message)
        break
    }
  }

  // ── 组件 ────────────────────────────────────────────────────────────
  // 先建交互层与检视器：组件之间通过回调互相引用，构造期不触发对方（TDZ 安全）
  const interact = createInteract({
    stage,
    page,
    overlay,
    getRender: () => render,
    getDoc: () => doc,
    getViewportWidth: () => viewportWidth,
    getScale: () => scale,
    send,
    onSelect: () => inspector.refresh(),
    onModeChange: (mode: CanvasMode) => toolbar.setMode(mode),
    onLoupeChange: (on) => toolbar.setLoupe(on),
    toast
  })

  const inspector = createInspector({
    root: inspectorEl,
    getDoc: () => doc,
    getSelectedId: () => interact.getSelectedId(),
    getViewportWidth: () => viewportWidth,
    measureLayoutRect,
    send,
    select: (id) => interact.select(id),
    toast
  })

  const toolbar = createToolbar({
    root: toolbarEl,
    send,
    getViewportWidth: () => viewportWidth,
    getZoom: () => zoom,
    getScale: () => scale,
    onViewport: setViewportWidth,
    onLocateToggle: () => toggleMode('locate'),
    onMeasureToggle: () => toggleMode('measure'),
    onLoupeToggle: () => {
      interact.toggleLoupe()
    },
    onZoomCycle: cycleZoomAction,
    toast
  })

  const variants = createVariants({
    root: variantsEl,
    getDoc: () => doc,
    send,
    onOpenChange: (open) => stage.classList.toggle('is-variants-open', open),
    toast
  })

  function toggleMode(target: CanvasMode): void {
    const next: CanvasMode = interact.getMode() === target ? 'select' : target
    interact.setMode(next)
    toolbar.setMode(next)
  }

  // ── 宿主连接 ────────────────────────────────────────────────────────
  const realHost = readCanvasHost()
  if (realHost) {
    host = realHost
  } else {
    demoHost = createDemoHost({ measure: measureLayoutRect, emit: handleInbound, toast })
    host = demoHost
  }

  // 初始占位：等待宿主的 document（演示宿主在 ready() 后立刻推一份）
  try {
    render = renderDocument(doc, page)
  } catch (error) {
    console.error('[canvas] 初始占位渲染失败', error)
  }
  toolbar.setDemo(Boolean(demoHost))
  waitingEl.hidden = false
  setText(
    waitingEl,
    demoHost
      ? '演示模式：未检测到 window.canvasHost，正在加载内置示例文档（按 V 可触发变体对比）'
      : '等待宿主推送设计文档…'
  )
  applyViewport(false)
  inspector.refresh()

  // ── 快捷键 ──────────────────────────────────────────────────────────
  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    const tag = target.tagName
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      target.isContentEditable
    )
  }

  on<KeyboardEvent>(window, 'keydown', (event) => {
    const key = event.key
    const lower = key.toLowerCase()

    if ((event.ctrlKey || event.metaKey) && lower === 'z') {
      event.preventDefault()
      send({ type: event.shiftKey ? 'redo' : 'undo' })
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return

    if (isEditableTarget(event.target)) {
      if (key === 'Escape') toolbar.closeCommit()
      return
    }

    if (key === 'Escape') {
      event.preventDefault()
      if (variants.isOpen()) {
        variants.hide()
        return
      }
      if (toolbar.closeCommit()) return
      interact.cancel()
      return
    }

    if (variants.isOpen()) {
      if (key >= '1' && key <= '3') {
        event.preventDefault()
        variants.choose(Number(key) - 1)
      }
      return
    }

    if (lower === 'm') {
      event.preventDefault()
      interact.toggleLoupe()
      return
    }
    if (lower === 'z') {
      event.preventDefault()
      cycleZoomAction()
      return
    }
    if (lower === 'r') {
      event.preventDefault()
      toggleMode('measure')
      return
    }
    if (lower === 'v' && demoHost) {
      event.preventDefault()
      demoHost.pushVariants()
    }
  })

  // ── 窗口尺寸变化：重新适配缩放（不发给宿主）────────────────────────
  on<Event>(window, 'resize', () => {
    if (resizeFrame) return
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0
      applyViewport(false)
    })
  })

  // ── 启动 ────────────────────────────────────────────────────────────
  if (!host) {
    console.error('[canvas] 没有可用的宿主，画布不会响应消息')
    return
  }
  host.on(handleInbound)
  host.ready()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true })
} else {
  boot()
}
