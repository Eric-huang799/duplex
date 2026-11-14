/**
 * 设计定位器 + 测量尺（L / R 模式）。
 *
 * - **定位（locate）**：十字准线跟随鼠标，显示鼠标下元素的描边与 9 个候选锚点；
 *   捕获阶段拦截 click / mousedown（preventDefault + stopPropagation），页面不会
 *   产生副作用；点一下把 `{ targetId, anchor, point, frameWidth }` 回调出去。
 * - **测量（measure）**：两次点击得到距离与水平/垂直分量，可连续测量多段；
 *   移动时显示吸附参考线，Esc 退出。
 *
 * 两个模式互斥（begin 会自动切走另一个），Esc 退出当前模式；定位器本身不持有
 * 键盘的 L/R 绑定（那在 design-api 里，便于三个模式统一互斥）。
 *
 * 拦截全部挂在 window 捕获阶段，所以本层是 `pointer-events: none`，不改变页面
 * 的命中测试；也正因为如此，跨域 iframe 内部的事件拦不到（见 README 的脆弱点）。
 */
import { anchorPoint } from '../shared/design/model'
import {
  ANCHOR_NAMES,
  elementTargetId,
  formatMeasureDelta,
  formatMeasurePrimary,
  measureBetween,
  nearestAnchor,
  resolveSnap
} from './design-utils'
import type {
  AnchorName,
  Measurement,
  Point,
  SnapDecision,
  SnapRect,
  Viewport
} from './design-utils'

const HOST_ID = '__duplex_locator_layer'
const Z_INDEX = 2147483500
const FONT_STACK = "-apple-system, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif"
const SVG_NS = 'http://www.w3.org/2000/svg' as const
const SNAP_THRESHOLD = 8
const GRID_STEP = 8

export type LocatorKind = 'locate' | 'measure'

export interface LocatorPick {
  /** 目标元素的可定位 id：data-did > #id > 小写标签名。 */
  targetId: string
  /** 九点锚点名（吸附不到时取离落点最近的锚点）。 */
  anchor: string
  /** 视口坐标（clientX/clientY 取整到 0.1px），与 frameWidth 一起描述设计帧内的位置意图。 */
  point: Point
  /** 设计帧宽度：documentElement 的布局宽度。 */
  frameWidth: number
}

export interface Locator {
  begin(kind: LocatorKind): void
  end(): void
  isActive(): boolean
  kind(): LocatorKind | null
  onPick(cb: (pick: LocatorPick) => void): () => void
  clearMeasurements(): void
  destroy(): void
}

interface CommittedMeasure {
  /** 文档坐标（= 视口坐标 + 滚动），滚动后测量线仍跟着页面内容。 */
  from: Point
  to: Point
  measurement: Measurement
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer {
  position: fixed;
  inset: 0;
  display: none;
  pointer-events: none;
  font: 11.5px/1.4 ${FONT_STACK};
  color: #d7dde5;
}
.layer.on { display: block; }
.xv, .xh {
  position: fixed;
  background: rgba(120, 200, 255, 0.5);
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.35);
}
.xv { top: 0; bottom: 0; width: 1px; }
.xh { left: 0; right: 0; height: 1px; }
.target-box {
  position: fixed;
  display: none;
  border: 1.5px solid rgba(77, 163, 255, 0.95);
  background: rgba(77, 163, 255, 0.07);
  border-radius: 2px;
}
.anchor {
  position: fixed;
  display: none;
  width: 7px;
  height: 7px;
  margin: -3.5px 0 0 -3.5px;
  border-radius: 50%;
  background: rgba(15, 20, 26, 0.92);
  border: 1.5px solid rgba(77, 163, 255, 0.95);
}
.anchor.hot { background: #4da3ff; box-shadow: 0 0 0 2px rgba(77, 163, 255, 0.25); }
.guide { position: fixed; display: none; background: rgba(232, 184, 75, 0.5); }
.guide.v { top: 0; bottom: 0; width: 1px; }
.guide.h { left: 0; right: 0; height: 1px; }
.snap-dot {
  position: fixed;
  display: none;
  width: 9px;
  height: 9px;
  margin: -4.5px 0 0 -4.5px;
  border-radius: 50%;
  border: 2px solid #e8b84b;
  background: rgba(232, 184, 75, 0.18);
}
.badge {
  position: fixed;
  display: none;
  max-width: 260px;
  padding: 2px 7px;
  border-radius: 5px;
  background: rgba(15, 20, 26, 0.9);
  border: 1px solid rgba(77, 163, 255, 0.35);
  color: #cfe2ff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip {
  position: fixed;
  display: none;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(15, 20, 26, 0.88);
  border: 1px solid rgba(77, 163, 255, 0.3);
  color: #d7dde5;
  white-space: nowrap;
}
.measure-svg {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  overflow: visible;
  pointer-events: none;
}
.measure-svg line { stroke: #e8b84b; stroke-width: 1.5; }
.measure-svg line.dashed { stroke: rgba(232, 184, 75, 0.7); stroke-dasharray: 4 4; }
.measure-svg line.preview { opacity: 0.85; }
.measure-svg circle { fill: #e8b84b; }
.measure-svg circle.dashed { fill: none; stroke: rgba(232, 184, 75, 0.8); stroke-dasharray: 3 3; }
.labels { position: fixed; inset: 0; pointer-events: none; }
.mlabel {
  position: fixed;
  transform: translate(-50%, -120%);
  padding: 1px 6px;
  border-radius: 5px;
  background: rgba(15, 20, 26, 0.92);
  border: 1px solid rgba(232, 184, 75, 0.45);
  color: #f0d9a0;
  white-space: nowrap;
}
.mlabel.below { transform: translate(-50%, 30%); }
`

function svgElement(tag: 'line' | 'circle'): SVGElement {
  return document.createElementNS(SVG_NS, tag)
}

function finitePoint(point: Point | null): Point | null {
  if (!point) return null
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null
}

function roundCoord(value: number): number {
  return Math.round(value * 10) / 10
}

export function createLocator(): Locator {
  const noop: Locator = {
    begin: () => {},
    end: () => {},
    isActive: () => false,
    kind: () => null,
    onPick: () => () => {},
    clearMeasurements: () => {},
    destroy: () => {}
  }
  if (typeof document === 'undefined') return noop
  const parent = document.body ?? document.documentElement
  if (!parent) return noop

  document.getElementById(HOST_ID)?.remove()
  const host = document.createElement('div')
  host.id = HOST_ID
  host.setAttribute('data-duplex-design-layer', 'locator')
  host.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${Z_INDEX};contain:layout style;`
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CSS
  root.appendChild(style)

  const layer = document.createElement('div')
  layer.className = 'layer'
  const crossV = document.createElement('div')
  crossV.className = 'xv'
  const crossH = document.createElement('div')
  crossH.className = 'xh'
  const targetBox = document.createElement('div')
  targetBox.className = 'target-box'
  const guideV = document.createElement('div')
  guideV.className = 'guide v'
  const guideH = document.createElement('div')
  guideH.className = 'guide h'
  const snapDot = document.createElement('div')
  snapDot.className = 'snap-dot'
  const badge = document.createElement('div')
  badge.className = 'badge'
  const chip = document.createElement('div')
  chip.className = 'chip'
  layer.append(crossV, crossH, targetBox, guideV, guideH, snapDot, badge, chip)

  const anchorDots: HTMLDivElement[] = []
  for (const name of ANCHOR_NAMES) {
    const dot = document.createElement('div')
    dot.className = 'anchor'
    dot.dataset.anchor = name
    layer.appendChild(dot)
    anchorDots.push(dot)
  }

  const svgRoot = document.createElementNS(SVG_NS, 'svg')
  svgRoot.setAttribute('class', 'measure-svg')
  svgRoot.setAttribute('aria-hidden', 'true')
  const labelsEl = document.createElement('div')
  labelsEl.className = 'labels'

  root.append(layer, svgRoot, labelsEl)
  parent.appendChild(host)

  let mode: LocatorKind | null = null
  let destroyed = false
  let pointer: Point | null = null
  let lastPointer: Point | null = null
  let startDoc: Point | null = null
  let rafId = 0
  const measurements: CommittedMeasure[] = []
  const committedNodes: Element[] = []
  const previewNodes: Element[] = []
  const callbacks = new Set<(pick: LocatorPick) => void>()

  function viewportSize(): Viewport {
    return { width: window.innerWidth, height: window.innerHeight }
  }

  function toClient(point: Point): Point {
    return { x: point.x - window.scrollX, y: point.y - window.scrollY }
  }

  function toDoc(point: Point): Point {
    return { x: point.x + window.scrollX, y: point.y + window.scrollY }
  }

  function identityOf(element: Element): string {
    return elementTargetId({
      did: element.getAttribute('data-did'),
      id: element.getAttribute('id'),
      tag: element.tagName
    })
  }

  function elementAt(point: Point): Element | null {
    if (typeof document.elementFromPoint !== 'function') return null
    const hit = document.elementFromPoint(point.x, point.y)
    if (!hit) return null
    if (hit === host || host.contains(hit)) return null
    return hit
  }

  function rectOf(element: Element): { x: number; y: number; width: number; height: number } {
    const rect = element.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }

  /** 候选元素：鼠标下的元素 + 至多 2 层祖先 + 至多 4 个兄弟（视觉上最近的元素）。 */
  function collectSnapRects(element: Element | null): SnapRect[] {
    const out: SnapRect[] = []
    if (!element) return out
    const seen = new Set<Element>()
    const add = (node: Element | null): void => {
      if (!node || seen.has(node) || node === host) return
      const rect = rectOf(node)
      if (rect.width < 1 || rect.height < 1) return
      seen.add(node)
      out.push({ id: identityOf(node), rect })
    }
    add(element)
    let ancestor = element.parentElement
    for (let depth = 0; depth < 2 && ancestor; depth++) {
      add(ancestor)
      ancestor = ancestor.parentElement
    }
    const siblings = element.parentElement?.children
    if (siblings) {
      let added = 0
      for (let i = 0; i < siblings.length && added < 4; i++) {
        const sibling = siblings[i]
        if (!sibling || sibling === element) continue
        const before = out.length
        add(sibling)
        if (out.length > before) added++
      }
    }
    return out
  }

  function decisionFor(point: Point): SnapDecision {
    return resolveSnap(point, collectSnapRects(elementAt(point)), {
      viewport: viewportSize(),
      threshold: SNAP_THRESHOLD,
      step: GRID_STEP
    })
  }

  function clearNodes(nodes: Element[]): void {
    for (const node of nodes) node.remove()
    nodes.length = 0
  }

  function addLine(
    nodes: Element[],
    from: Point,
    to: Point,
    options: { dashed?: boolean; preview?: boolean } = {}
  ): void {
    const line = svgElement('line')
    line.setAttribute('x1', from.x.toFixed(2))
    line.setAttribute('y1', from.y.toFixed(2))
    line.setAttribute('x2', to.x.toFixed(2))
    line.setAttribute('y2', to.y.toFixed(2))
    if (options.dashed) line.classList.add('dashed')
    if (options.preview) line.classList.add('preview')
    svgRoot.appendChild(line)
    nodes.push(line)
  }

  function addDot(
    nodes: Element[],
    point: Point,
    options: { dashed?: boolean } = {}
  ): void {
    const dot = svgElement('circle')
    dot.setAttribute('cx', point.x.toFixed(2))
    dot.setAttribute('cy', point.y.toFixed(2))
    dot.setAttribute('r', options.dashed ? '2.5' : '3')
    if (options.dashed) dot.classList.add('dashed')
    svgRoot.appendChild(dot)
    nodes.push(dot)
  }

  function addLabel(nodes: Element[], text: string, x: number, y: number, below = false): void {
    const label = document.createElement('div')
    label.className = below ? 'mlabel below' : 'mlabel'
    label.textContent = text
    label.style.left = `${x.toFixed(2)}px`
    label.style.top = `${y.toFixed(2)}px`
    labelsEl.appendChild(label)
    nodes.push(label)
  }

  function drawMeasure(
    nodes: Element[],
    from: Point,
    to: Point,
    measurement: Measurement,
    preview: boolean
  ): void {
    const options = { preview }
    addLine(nodes, from, to, options)
    addLine(nodes, from, { x: to.x, y: from.y }, { ...options, dashed: true })
    addLine(nodes, { x: to.x, y: from.y }, to, { ...options, dashed: true })
    addDot(nodes, from)
    addDot(nodes, to)
    const midX = (from.x + to.x) / 2
    const midY = (from.y + to.y) / 2
    addLabel(nodes, formatMeasurePrimary(measurement), midX, midY - 4)
    addLabel(nodes, formatMeasureDelta(measurement), midX, midY + 14, true)
  }

  function renderMeasurements(): void {
    clearNodes(committedNodes)
    for (const item of measurements) {
      drawMeasure(committedNodes, toClient(item.from), toClient(item.to), item.measurement, false)
    }
  }

  function renderPreview(decision: SnapDecision): void {
    clearNodes(previewNodes)
    if (!startDoc) return
    const from = toClient(startDoc)
    const to = decision.point
    drawMeasure(previewNodes, from, to, measureBetween(from, to), true)
  }

  function positionCrosshair(cursor: Point): void {
    crossV.style.left = `${cursor.x.toFixed(2)}px`
    crossH.style.top = `${cursor.y.toFixed(2)}px`
  }

  function renderTarget(target: Element | null): void {
    if (!target) {
      targetBox.style.display = 'none'
      return
    }
    const rect = rectOf(target)
    targetBox.style.display = 'block'
    targetBox.style.left = `${rect.x.toFixed(2)}px`
    targetBox.style.top = `${rect.y.toFixed(2)}px`
    targetBox.style.width = `${rect.width.toFixed(2)}px`
    targetBox.style.height = `${rect.height.toFixed(2)}px`
  }

  function renderAnchors(target: Element | null, hot: AnchorName | null): void {
    if (!target) {
      for (const dot of anchorDots) dot.style.display = 'none'
      return
    }
    const rect = rectOf(target)
    for (let i = 0; i < anchorDots.length; i++) {
      const dot = anchorDots[i]
      const name = ANCHOR_NAMES[i]
      if (!dot || !name) continue
      const anchor = anchorPoint(rect, name)
      dot.style.display = 'block'
      dot.style.left = `${anchor.x.toFixed(2)}px`
      dot.style.top = `${anchor.y.toFixed(2)}px`
      dot.classList.toggle('hot', hot === name)
    }
  }

  function renderSnap(decision: SnapDecision): void {
    if (!decision.snapped) {
      snapDot.style.display = 'none'
      guideV.style.display = 'none'
      guideH.style.display = 'none'
      return
    }
    snapDot.style.display = 'block'
    snapDot.style.left = `${decision.point.x.toFixed(2)}px`
    snapDot.style.top = `${decision.point.y.toFixed(2)}px`
    guideV.style.display = 'block'
    guideV.style.left = `${decision.point.x.toFixed(2)}px`
    guideH.style.display = 'block'
    guideH.style.top = `${decision.point.y.toFixed(2)}px`
  }

  function renderBadge(target: Element | null, decision: SnapDecision, cursor: Point): void {
    if (!target) {
      badge.style.display = 'none'
      return
    }
    const source = decision.snapped
      ? decision.snapped.from === 'grid'
        ? '网格'
        : decision.anchor
          ? '锚点'
          : '页边'
      : ''
    badge.textContent = `${identityOf(target)} · ${decision.anchor ?? '自由点'}${
      source ? ` · ${source}` : ''
    }`
    badge.style.display = 'block'
    badge.style.left = `${Math.max(6, Math.min(cursor.x + 14, window.innerWidth - 272))}px`
    badge.style.top = `${Math.min(Math.max(6, cursor.y + 16), window.innerHeight - 26)}px`
  }

  function updateChip(): void {
    if (!mode) {
      chip.style.display = 'none'
      return
    }
    chip.style.display = 'block'
    chip.textContent =
      mode === 'locate'
        ? '定位模式 · 单击确认锚点 · Esc 退出'
        : startDoc
          ? '测量模式 · 单击终点 · 再次单击开始新测量 · Esc 退出'
          : '测量模式 · 单击起点 · Esc 退出'
  }

  function render(): void {
    if (!mode || destroyed) return
    const cursor = finitePoint(pointer)
    if (!cursor) return
    const target = elementAt(cursor)
    const decision = resolveSnap(cursor, collectSnapRects(target), {
      viewport: viewportSize(),
      threshold: SNAP_THRESHOLD,
      step: GRID_STEP
    })
    positionCrosshair(cursor)
    renderTarget(target)
    renderAnchors(target, decision.anchor)
    renderSnap(decision)
    renderBadge(target, decision, cursor)
    updateChip()
    if (mode === 'measure') renderPreview(decision)
    else clearNodes(previewNodes)
  }

  function scheduleRender(): void {
    if (rafId !== 0) return
    rafId = window.requestAnimationFrame(() => {
      rafId = 0
      render()
    })
  }

  function end(): void {
    mode = null
    startDoc = null
    layer.classList.remove('on')
    chip.style.display = 'none'
    badge.style.display = 'none'
    targetBox.style.display = 'none'
    snapDot.style.display = 'none'
    guideV.style.display = 'none'
    guideH.style.display = 'none'
    for (const dot of anchorDots) dot.style.display = 'none'
    clearNodes(previewNodes)
    if (rafId !== 0) {
      window.cancelAnimationFrame(rafId)
      rafId = 0
    }
  }

  function begin(kind: LocatorKind): void {
    if (destroyed) return
    if (kind !== 'locate' && kind !== 'measure') return
    startDoc = null
    mode = kind
    layer.classList.add('on')
    pointer = finitePoint(lastPointer) ?? viewportSizeCenter()
    renderMeasurements()
    render()
  }

  function viewportSizeCenter(): Point {
    const size = viewportSize()
    return { x: size.width / 2, y: size.height / 2 }
  }

  function confirmPick(cursor: Point): void {
    const target = elementAt(cursor)
    const decision = resolveSnap(cursor, collectSnapRects(target), {
      viewport: viewportSize(),
      threshold: SNAP_THRESHOLD,
      step: GRID_STEP
    })
    const rect = target ? rectOf(target) : null
    const anchor: AnchorName = decision.anchor ?? (rect ? nearestAnchor(rect, decision.point).anchor : 'center')
    const pick: LocatorPick = {
      targetId: target ? identityOf(target) : 'body',
      anchor,
      point: { x: roundCoord(decision.point.x), y: roundCoord(decision.point.y) },
      frameWidth: document.documentElement.clientWidth || viewportSize().width
    }
    for (const callback of callbacks) {
      try {
        callback(pick)
      } catch {
        /* 回调出错不能破坏 overlay */
      }
    }
    end()
  }

  function registerMeasureClick(cursor: Point): void {
    const decision = decisionFor(cursor)
    if (!startDoc) {
      startDoc = toDoc(decision.point)
      render()
      return
    }
    const endPoint = toDoc(decision.point)
    const from = startDoc
    measurements.push({
      from,
      to: endPoint,
      measurement: measureBetween(from, endPoint)
    })
    startDoc = null
    renderMeasurements()
    render()
  }

  // ---- window-level capture listeners ----

  function onMouseMove(event: MouseEvent): void {
    lastPointer = { x: event.clientX, y: event.clientY }
    if (!mode) return
    pointer = lastPointer
    scheduleRender()
  }

  function block(event: Event): void {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }

  function onPointerDown(event: PointerEvent): void {
    if (!mode || event.button !== 0) return
    // 只挡页面自己的 pointerdown 处理器，不 preventDefault：取消 pointerdown 的
    // 默认行为在部分浏览器会抑制后续兼容鼠标事件（含 click），那会把“点一下确认”也吞掉。
    event.stopPropagation()
  }

  function onMouseDown(event: MouseEvent): void {
    if (!mode || event.button !== 0) return
    block(event)
  }

  function onClick(event: MouseEvent): void {
    if (!mode) return
    block(event)
    const cursor = { x: event.clientX, y: event.clientY }
    pointer = cursor
    if (mode === 'locate') confirmPick(cursor)
    else registerMeasureClick(cursor)
  }

  function onContextMenu(event: MouseEvent): void {
    if (!mode) return
    block(event)
  }

  function onDragStart(event: Event): void {
    if (!mode) return
    block(event)
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!mode) return
    if (event.key === 'Escape') {
      block(event)
      end()
    }
  }

  function onScroll(): void {
    if (measurements.length > 0) renderMeasurements()
    if (mode) scheduleRender()
  }

  function onResize(): void {
    renderMeasurements()
    if (mode) scheduleRender()
  }

  function onPageHide(): void {
    end()
  }

  function onNavigate(): void {
    end()
    measurements.length = 0
    renderMeasurements()
  }

  function onBeforeUnload(): void {
    destroy()
  }

  window.addEventListener('mousemove', onMouseMove, { capture: true, passive: true })
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('mousedown', onMouseDown, true)
  window.addEventListener('click', onClick, true)
  window.addEventListener('contextmenu', onContextMenu, true)
  window.addEventListener('dragstart', onDragStart, true)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('scroll', onScroll, { capture: true, passive: true })
  window.addEventListener('resize', onResize)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('popstate', onNavigate)
  window.addEventListener('hashchange', onNavigate)

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    end()
    window.removeEventListener('mousemove', onMouseMove, { capture: true })
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('mousedown', onMouseDown, true)
    window.removeEventListener('click', onClick, true)
    window.removeEventListener('contextmenu', onContextMenu, true)
    window.removeEventListener('dragstart', onDragStart, true)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('scroll', onScroll, { capture: true })
    window.removeEventListener('resize', onResize)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('beforeunload', onBeforeUnload)
    window.removeEventListener('popstate', onNavigate)
    window.removeEventListener('hashchange', onNavigate)
    callbacks.clear()
    measurements.length = 0
    clearNodes(committedNodes)
    clearNodes(previewNodes)
    host.remove()
  }

  return {
    begin,
    end,
    isActive: () => mode !== null,
    kind: () => mode,
    onPick(cb: (pick: LocatorPick) => void): () => void {
      callbacks.add(cb)
      return () => {
        callbacks.delete(cb)
      }
    },
    clearMeasurements(): void {
      measurements.length = 0
      startDoc = null
      renderMeasurements()
      if (mode) render()
    },
    destroy
  }
}
