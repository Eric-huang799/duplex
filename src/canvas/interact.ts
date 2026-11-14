/**
 * 画布交互层：选择 / 拖拽吸附 / 定位器 / 放大镜 / 测量尺 / 远端光标。
 *
 * 坐标：所有内部计算都在 layout（设计帧）坐标里做，绘制到 overlay 时才换算成
 * "stage 滚动内容坐标"。发给宿主的落点一律是 layout 坐标 + 当前 frameWidth。
 *
 * 关键约束：
 *  - 拖拽**不改文档**，松手只发 `user-move`；
 *  - 定位器只发 `user-locate`；
 *  - 生成节点没有任何事件处理器，交互全部委托到 stage 上；
 *  - 定位/测量模式下在捕获阶段 preventDefault，页面元素不会触发自己的行为。
 */

import {
  collectIds,
  findNode,
  isLocked,
  type AnchorName,
  type DesignDocument,
  type DesignNode,
  type Point,
  type Rect,
  type SnapCandidate
} from '../shared/design/model'
import {
  anchorCandidatesOf,
  ancestorIds,
  containerEdgeCandidates,
  formatDelta,
  formatPx,
  gridCandidatesNear,
  layoutToScreen,
  measureBetween,
  nearestAnchor,
  screenRectToLayout,
  screenToLayout,
  snapThresholdForScale,
  snapToTiers,
  type Measurement,
  type RectTarget,
  type SnapTier,
  type TierSnapResult
} from './geometry'
import { el, on, setText, toRect } from './dom'
import type { CanvasRender } from './render'
import type { OutboundMessage } from './host'

export type CanvasMode = 'select' | 'locate' | 'measure'

const DRAG_THRESHOLD = 4
const SNAP_DOT_RANGE = 140
const SNAP_DOT_LIMIT = 24
const LOUPE_SIZE = 200
const LOUPE_ZOOM = 1.8
const REMOTE_CURSOR_TTL = 4000
const CANVAS_UI = '[data-canvas-ui]'

export interface InteractDeps {
  stage: HTMLElement
  page: HTMLElement
  overlay: HTMLElement
  getRender(): CanvasRender | null
  getDoc(): DesignDocument | null
  getViewportWidth(): number
  getScale(): number
  send(message: OutboundMessage): void
  onSelect(id: string | null): void
  onModeChange(mode: CanvasMode): void
  onLoupeChange(on: boolean): void
  toast(text: string): void
}

export interface InteractHandle {
  select(id: string | null, options?: { silent?: boolean }): void
  getSelectedId(): string | null
  setMode(mode: CanvasMode): void
  getMode(): CanvasMode
  toggleLoupe(): boolean
  isLoupeOn(): boolean
  refresh(): void
  cancel(): void
  showRemoteCursor(cursor: { actor: string; x: number; y: number; state: string }): void
  destroy(): void
}

interface SnapBase {
  anchors: SnapCandidate[]
  edgeTargets: RectTarget[]
}

interface DragState {
  id: string
  pointerId: number
  startClient: Point
  startClientRect: Rect
  active: boolean
  ghostWidth: number
  ghostHeight: number
  lastPoint: Point | null
  lastTier: SnapTier | null
  lastName: string | null
}

interface LocateState {
  targetId: string
  anchor: AnchorName
  point: Point
  from: string | null
}

interface LoupeCache {
  source: HTMLElement
  version: number
}

export function createInteract(deps: InteractDeps): InteractHandle {
  const disposers: Array<() => void> = []
  const hint = el('div', { className: 'canvas-hint' })
  const snapDots = el('div', { className: 'snap-dots' })
  const guideV = el('div', { className: 'guide guide--v', attrs: { hidden: '' } })
  const guideH = el('div', { className: 'guide guide--h', attrs: { hidden: '' } })
  const ghost = el('div', { className: 'ghost', attrs: { hidden: '' } })
  const ghostLabel = el('span', { className: 'ghost__label' })
  ghost.append(ghostLabel)

  const locatePin = el('div', { className: 'locate-pin', attrs: { hidden: '' } })
  const locatePinLabel = el('span', { className: 'locate-pin__label' })
  locatePin.append(
    el('span', { className: 'locate-pin__dot' }),
    el('span', { className: 'locate-pin__ring' }),
    locatePinLabel
  )

  const locateInfo = el('span', { className: 'locate-confirm__info' })
  const locateYes = el('button', {
    className: 'locate-confirm__btn locate-confirm__btn--primary',
    text: '确认定位',
    attrs: { type: 'button' }
  })
  const locateNo = el('button', {
    className: 'locate-confirm__btn',
    text: '取消',
    attrs: { type: 'button' }
  })
  const locateConfirm = el('div', {
    className: 'locate-confirm',
    attrs: { hidden: '', 'data-canvas-ui': '' }
  })
  locateConfirm.append(
    el('span', { className: 'locate-confirm__title', text: '定位锚点' }),
    locateInfo,
    locateYes,
    locateNo
  )

  const measureLayer = el('div', { className: 'measure-layer', attrs: { hidden: '' } })
  const measureLine = el('div', { className: 'measure-line' })
  const measureH = el('div', { className: 'measure-comp measure-comp--h' })
  const measureV = el('div', { className: 'measure-comp measure-comp--v' })
  const measureDotA = el('div', { className: 'measure-dot' })
  const measureDotB = el('div', { className: 'measure-dot' })
  const measureLabel = el('div', { className: 'measure-label' })
  measureLayer.append(measureLine, measureH, measureV, measureDotA, measureDotB, measureLabel)

  const loupe = el('div', { className: 'loupe', attrs: { hidden: '' } })
  const loupeStage = el('div', { className: 'loupe__stage' })
  const loupeHolder = el('div', { className: 'loupe__holder' })
  loupeStage.append(loupeHolder)
  const loupeRows: Record<string, HTMLElement> = {}
  const loupeInfo = el('div', { className: 'loupe__info' })
  for (const [key, label] of [
    ['point', '坐标'],
    ['did', 'data-did'],
    ['size', '尺寸'],
    ['bg', '背景'],
    ['color', '文字']
  ] as Array<[string, string]>) {
    const value = el('b', { className: 'loupe__value', text: '—' })
    loupeRows[key] = value
    const row = el('div', { className: 'loupe__row' })
    row.append(el('span', { className: 'loupe__key', text: label }), value)
    loupeInfo.append(row)
  }
  loupe.append(el('div', { className: 'loupe__title', text: '放大镜 · M 关闭' }), loupeStage, loupeInfo)

  const cursorLayer = el('div', { className: 'cursor-layer' })

  deps.overlay.append(
    hint,
    snapDots,
    guideV,
    guideH,
    ghost,
    locatePin,
    locateConfirm,
    measureLayer,
    loupe,
    cursorLayer
  )

  // ── 状态 ────────────────────────────────────────────────────────────
  let mode: CanvasMode = 'select'
  let selectedId: string | null = null
  let hoverId: string | null = null
  let drag: DragState | null = null
  let locate: LocateState | null = null
  let locatePreview: Point | null = null
  let measureStart: Point | null = null
  let measureCurrent: Point | null = null
  let measurement: Measurement | null = null
  let loupeOn = false
  let loupeCache: LoupeCache | null = null
  let snapBaseCache: { version: number; excludeId: string | null; base: SnapBase } | null = null
  const remoteCursors = new Map<string, { element: HTMLElement; timer: number }>()

  // ── 坐标换算 ────────────────────────────────────────────────────────
  function scale(): number {
    return deps.getScale()
  }

  function pageOrigin(): Point {
    const rect = deps.page.getBoundingClientRect()
    return { x: rect.left, y: rect.top }
  }

  function overlayPointOf(client: Point): Point {
    const rect = deps.stage.getBoundingClientRect()
    return {
      x: client.x - rect.left + deps.stage.scrollLeft,
      y: client.y - rect.top + deps.stage.scrollTop
    }
  }

  function layoutToOverlay(point: Point): Point {
    return overlayPointOf(layoutToScreen(point, pageOrigin(), scale()))
  }

  function clientToLayout(point: Point): Point {
    return screenToLayout(point, pageOrigin(), scale())
  }

  /**
   * 预览布局坐标 → 设计帧坐标。
   *
   * 画布把文档按 `--frame-scale = 预览宽 / 帧宽` 缩放渲染，所以屏幕量到的布局 px
   * 属于**预览空间**；而 `style.x/y`、约束里的坐标一律存**设计帧坐标**。
   * 所有发往宿主/检视器的坐标都在这里统一换算，避免在 390/834 预览下二次缩放。
   */
  function frameScaleFactor(): number {
    const doc = deps.getDoc()
    const viewport = Math.max(1, deps.getViewportWidth())
    return (doc?.frame.width ?? viewport) / viewport
  }
  function rectOf(id: string): Rect | null {
    const element = deps.getRender()?.get(id)
    if (!element) return null
    return screenRectToLayout(toRect(element.getBoundingClientRect()), pageOrigin(), scale())
  }

  function clientRectOf(id: string): Rect | null {
    const element = deps.getRender()?.get(id)
    return element ? toRect(element.getBoundingClientRect()) : null
  }

  function setHidden(element: HTMLElement, hidden: boolean): void {
    element.hidden = hidden
  }

  function isCanvasUi(event: Event): boolean {
    return (event.target as Element | null)?.closest(CANVAS_UI) !== null
  }

  function sourceElementOf(event: Event): HTMLElement | null {
    const target = event.target as Element | null
    if (!target) return null
    const node = target.closest<HTMLElement>('[data-node]')
    if (node && deps.page.contains(node)) return node
    return null
  }

  // ── 提示条 ──────────────────────────────────────────────────────────
  function updateHint(): void {
    const parts: string[] = []
    if (mode === 'select') {
      parts.push('选择：点击元素 · 拖动移动（吸附 9 点锚点 / 容器边缘 / 8px 网格）')
    } else if (mode === 'locate') {
      parts.push('定位：点击页面元素取锚点，确认后发送给宿主（Esc 退出）')
    } else {
      parts.push('测量：点击两点量距离与水平/垂直分量（Esc 退出）')
    }
    parts.push(`M 放大镜${loupeOn ? '（开）' : ''}`, 'Z 缩放', 'R 测量', `当前视图 ${Math.round(scale() * 100)}%`)
    setText(hint, parts.join(' · '))
  }

  // ── 选择 / 悬停 ─────────────────────────────────────────────────────
  function select(id: string | null, options: { silent?: boolean } = {}): void {
    if (selectedId === id) {
      if (id) deps.getRender()?.get(id)?.classList.add('is-selected')
      return
    }
    if (selectedId) deps.getRender()?.get(selectedId)?.classList.remove('is-selected')
    selectedId = id
    if (id) {
      const element = deps.getRender()?.get(id)
      element?.classList.add('is-selected')
    }
    if (!options.silent) deps.send({ type: 'select', id })
    deps.onSelect(id)
  }

  function setHover(id: string | null): void {
    if (hoverId === id) return
    if (hoverId) deps.getRender()?.get(hoverId)?.classList.remove('is-hover')
    hoverId = id
    if (id) deps.getRender()?.get(id)?.classList.add('is-hover')
  }

  // ── 吸附候选 ────────────────────────────────────────────────────────
  function buildSnapBase(excludeId: string | null): SnapBase {
    const doc = deps.getDoc()
    const render = deps.getRender()
    if (!doc || !render) return { anchors: [], edgeTargets: [] }
    if (snapBaseCache && snapBaseCache.version === doc.version && snapBaseCache.excludeId === excludeId) {
      return snapBaseCache.base
    }

    const excluded = new Set<string>()
    if (excludeId) {
      const node = findNode(doc.root, excludeId)
      if (node) for (const id of collectIds(node)) excluded.add(id)
    }

    const anchors: SnapCandidate[] = []
    for (const element of render.list()) {
      const id = element.dataset.did
      if (!id || excluded.has(id) || id === doc.root.id) continue
      const rect = rectOf(id)
      if (rect) anchors.push(...anchorCandidatesOf([{ id, rect }]))
    }

    const edgeTargets: RectTarget[] = []
    const rootRect = rectOf(doc.root.id)
    if (rootRect) edgeTargets.push({ id: doc.root.id, rect: rootRect })
    if (excludeId) {
      for (const ancestorId of ancestorIds(doc.root, excludeId)) {
        if (ancestorId === doc.root.id) continue
        const rect = rectOf(ancestorId)
        if (rect) edgeTargets.push({ id: ancestorId, rect })
      }
    }

    const base = { anchors, edgeTargets }
    snapBaseCache = { version: doc.version, excludeId, base }
    return base
  }

  function snapAtLayout(desired: Point, excludeId: string | null): TierSnapResult {
    const base = buildSnapBase(excludeId)
    const threshold = snapThresholdForScale(scale())
    return snapToTiers(
      desired,
      [
        { tier: 'anchor', candidates: base.anchors },
        { tier: 'edge', candidates: containerEdgeCandidates(base.edgeTargets, desired) },
        { tier: 'grid', candidates: gridCandidatesNear(desired) }
      ],
      threshold
    )
  }

  // ── 拖拽 ────────────────────────────────────────────────────────────
  function beginPointerDrag(event: PointerEvent): void {
    const doc = deps.getDoc()
    if (!doc) return
    const nodeElement = sourceElementOf(event)
    if (!nodeElement) {
      select(null)
      return
    }
    const id = nodeElement.dataset.did
    if (!id) return
    select(id)
    if (isLocked(doc.root, id)) {
      deps.toast('该节点已锁定，不能拖动')
      return
    }
    const startClientRect = clientRectOf(id)
    if (!startClientRect) return
    drag = {
      id,
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startClientRect,
      active: false,
      ghostWidth: startClientRect.width,
      ghostHeight: startClientRect.height,
      lastPoint: null,
      lastTier: null,
      lastName: null
    }
  }

  function updateDrag(event: PointerEvent): void {
    if (!drag) return
    const distance = Math.hypot(
      event.clientX - drag.startClient.x,
      event.clientY - drag.startClient.y
    )
    if (!drag.active) {
      if (distance < DRAG_THRESHOLD) return
      drag.active = true
      deps.stage.classList.add('is-dragging')
      setHidden(ghost, false)
    }

    const deltaX = event.clientX - drag.startClient.x
    const deltaY = event.clientY - drag.startClient.y
    const centerClient = {
      x: drag.startClientRect.x + deltaX + drag.startClientRect.width / 2,
      y: drag.startClientRect.y + deltaY + drag.startClientRect.height / 2
    }
    const desired = clientToLayout(centerClient)
    const result = snapAtLayout(desired, drag.id)
    drag.lastPoint = result.point
    drag.lastTier = result.tier
    drag.lastName = result.from

    const snappedClient = layoutToScreen(result.point, pageOrigin(), scale())
    const snappedOverlay = overlayPointOf(snappedClient)
    ghost.style.left = `${snappedOverlay.x - drag.ghostWidth / 2}px`
    ghost.style.top = `${snappedOverlay.y - drag.ghostHeight / 2}px`
    ghost.style.width = `${drag.ghostWidth}px`
    ghost.style.height = `${drag.ghostHeight}px`
    const suffix = result.tier ? `吸附 ${result.from}` : '自由移动'
    setText(
      ghostLabel,
      `(${Math.round(result.point.x)}, ${Math.round(result.point.y)}) · ${suffix}`
    )

    drawGuides(result)
    renderCandidateDots(buildSnapBase(drag.id).anchors, desired, result)
  }

  function drawGuides(result: TierSnapResult): void {
    if (!result.snapped) {
      setHidden(guideV, true)
      setHidden(guideH, true)
      return
    }
    const point = layoutToOverlay(result.point)
    guideV.style.left = `${point.x}px`
    guideV.style.top = `${deps.stage.scrollTop}px`
    guideV.style.height = `${deps.stage.clientHeight}px`
    guideH.style.left = `${deps.stage.scrollLeft}px`
    guideH.style.top = `${point.y}px`
    guideH.style.width = `${deps.stage.clientWidth}px`
    setHidden(guideV, false)
    setHidden(guideH, false)
  }

  function renderCandidateDots(
    anchors: SnapCandidate[],
    center: Point,
    result: TierSnapResult | null
  ): void {
    const overlayCenter = layoutToOverlay(center)
    const fragments = document.createDocumentFragment()
    let count = 0
    for (const candidate of anchors) {
      const overlay = layoutToOverlay(candidate.point)
      if (Math.hypot(overlay.x - overlayCenter.x, overlay.y - overlayCenter.y) > SNAP_DOT_RANGE) continue
      const dot = el('span', { className: 'snap-dot' })
      dot.style.left = `${overlay.x}px`
      dot.style.top = `${overlay.y}px`
      if (
        result?.snapped &&
        candidate.point.x === result.point.x &&
        candidate.point.y === result.point.y
      ) {
        dot.classList.add('is-active')
      }
      fragments.append(dot)
      count++
      if (count >= SNAP_DOT_LIMIT) break
    }
    snapDots.replaceChildren(fragments)
  }

  function finishDrag(): void {
    if (drag?.active && drag.lastPoint) {
      const target = { x: Math.round(drag.lastPoint.x), y: Math.round(drag.lastPoint.y) }
      // 当前包围盒（设计帧坐标；缩放/滚动都已换算掉），宿主用它 + moveDelta 算落点
      const currentRect =
        rectOf(drag.id) ??
        screenRectToLayout(toRect(drag.startClientRect), pageOrigin(), scale())
      const rect = {
        x: Math.round(currentRect.x * 100) / 100,
        y: Math.round(currentRect.y * 100) / 100,
        width: Math.round(currentRect.width * 100) / 100,
        height: Math.round(currentRect.height * 100) / 100
      }
      const k = frameScaleFactor()
      const frameTarget = { x: Math.round(target.x * k), y: Math.round(target.y * k) }
      const frameRect = {
        x: Math.round(rect.x * k * 100) / 100,
        y: Math.round(rect.y * k * 100) / 100,
        width: Math.round(rect.width * k * 100) / 100,
        height: Math.round(rect.height * k * 100) / 100
      }
      deps.send({
        type: 'user-move',
        id: drag.id,
        anchor: 'center',
        target: frameTarget,
        frameWidth: deps.getDoc()?.frame.width ?? deps.getViewportWidth(),
        rect: frameRect
      })
      deps.toast(
        `已发送移动意图：${drag.id} → (${target.x}, ${target.y})，由宿主转成约束/patch`
      )
    }
    endDrag()
  }

  function endDrag(): void {
    drag = null
    deps.stage.classList.remove('is-dragging')
    setHidden(ghost, true)
    setHidden(guideV, true)
    setHidden(guideH, true)
    snapDots.replaceChildren()
  }

  // ── 定位器 ──────────────────────────────────────────────────────────
  function updateLocatePreview(event: PointerEvent): void {
    const doc = deps.getDoc()
    if (!doc) return
    const nodeElement = sourceElementOf(event)
    const targetId = nodeElement?.dataset.did ?? doc.root.id
    setHover(targetId)
    const rect = rectOf(targetId)
    if (!rect) return
    const desired = clientToLayout({ x: event.clientX, y: event.clientY })
    const result = snapAtLayout(desired, targetId)
    locatePreview = result.point
    positionLocatePin(result.point, null)
    setHidden(locatePin, false)
    locatePin.classList.add('is-preview')
    renderCandidateDots(buildSnapBase(targetId).anchors, result.point, result)
  }

  function commitLocateClick(event: PointerEvent): void {
    const doc = deps.getDoc()
    if (!doc) return
    const nodeElement = sourceElementOf(event)
    const targetId = nodeElement?.dataset.did ?? doc.root.id
    const rect = rectOf(targetId)
    if (!rect) return
    const desired = clientToLayout({ x: event.clientX, y: event.clientY })
    const result = snapAtLayout(desired, targetId)
    locate = {
      targetId,
      anchor: nearestAnchor(rect, result.point),
      point: result.point,
      from: result.from
    }
    locatePreview = null
    locatePin.classList.remove('is-preview')
    positionLocatePin(result.point, locate)
    setHidden(locatePin, false)
    applyLocateTargetClass(targetId)
    renderCandidateDots(buildSnapBase(targetId).anchors, result.point, result)
    updateLocateConfirm()
  }

  function positionLocatePin(point: Point, pending: LocateState | null): void {
    const overlay = layoutToOverlay(point)
    locatePin.style.left = `${overlay.x}px`
    locatePin.style.top = `${overlay.y}px`
    const label = pending
      ? `${pending.targetId} · ${pending.anchor} · (${Math.round(point.x)}, ${Math.round(point.y)})`
      : `(${Math.round(point.x)}, ${Math.round(point.y)})`
    setText(locatePinLabel, label)
  }

  function applyLocateTargetClass(targetId: string): void {
    const render = deps.getRender()
    if (!render) return
    for (const element of render.list()) element.classList.remove('is-locate-target')
    render.get(targetId)?.classList.add('is-locate-target')
  }

  function updateLocateConfirm(): void {
    if (!locate) {
      setHidden(locateConfirm, true)
      return
    }
    setText(
      locateInfo,
      `${locate.targetId} · ${locate.anchor} · (${Math.round(locate.point.x)}, ${Math.round(locate.point.y)})${
        locate.from ? ` · 吸附 ${locate.from}` : ''
      }`
    )
    setHidden(locateConfirm, false)
  }

  function clearLocate(): void {
    locate = null
    locatePreview = null
    setHidden(locatePin, true)
    setHidden(locateConfirm, true)
    locatePin.classList.remove('is-preview')
    snapDots.replaceChildren()
    const render = deps.getRender()
    if (render) for (const element of render.list()) element.classList.remove('is-locate-target')
  }

  function confirmLocate(): void {
    if (!locate) return
    const pending = locate
    const k = frameScaleFactor()
    deps.send({
      type: 'user-locate',
      targetId: pending.targetId,
      anchor: pending.anchor,
      point: { x: Math.round(pending.point.x * k), y: Math.round(pending.point.y * k) },
      frameWidth: deps.getDoc()?.frame.width ?? deps.getViewportWidth()
    })
    deps.toast(
      `已发送定位意图：${pending.targetId} · ${pending.anchor} · (${Math.round(pending.point.x)}, ${Math.round(pending.point.y)})`
    )
    clearLocate()
    setMode('select')
  }

  // ── 测量 ────────────────────────────────────────────────────────────
  function measureAt(client: Point): Point {
    const desired = clientToLayout(client)
    const result = snapAtLayout(desired, null)
    return result.point
  }

  function drawMeasurement(
    a: Point,
    b: Point,
    options: { preview: boolean; snapLabel?: string | null }
  ): void {
    const overlayA = layoutToOverlay(a)
    const overlayB = layoutToOverlay(b)
    const measurementValue = measureBetween(a, b)
    const angle = Math.atan2(overlayB.y - overlayA.y, overlayB.x - overlayA.x)
    const mid = {
      x: (overlayA.x + overlayB.x) / 2,
      y: (overlayA.y + overlayB.y) / 2
    }

    measureLine.style.left = `${(overlayA.x + overlayB.x) / 2}px`
    measureLine.style.top = `${(overlayA.y + overlayB.y) / 2}px`
    measureLine.style.width = `${measurementValue.distance * scale()}px`
    measureLine.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`

    const horizontalLeft = Math.min(overlayA.x, overlayB.x)
    measureH.style.left = `${horizontalLeft}px`
    measureH.style.top = `${overlayA.y}px`
    measureH.style.width = `${Math.abs(overlayB.x - overlayA.x)}px`

    const verticalTop = Math.min(overlayA.y, overlayB.y)
    measureV.style.left = `${overlayB.x}px`
    measureV.style.top = `${verticalTop}px`
    measureV.style.height = `${Math.abs(overlayB.y - overlayA.y)}px`

    measureDotA.style.left = `${overlayA.x}px`
    measureDotA.style.top = `${overlayA.y}px`
    measureDotB.style.left = `${overlayB.x}px`
    measureDotB.style.top = `${overlayB.y}px`

    const parts = [
      `距离 ${formatPx(measurementValue.distance)}`,
      `Δx ${formatDelta(measurementValue.dx)}`,
      `Δy ${formatDelta(measurementValue.dy)}`,
      `(${Math.round(a.x)}, ${Math.round(a.y)}) → (${Math.round(b.x)}, ${Math.round(b.y)})`
    ]
    if (options.snapLabel) parts.push(`吸附 ${options.snapLabel}`)
    setText(measureLabel, parts.join(' · '))
    measureLabel.style.left = `${mid.x}px`
    measureLabel.style.top = `${mid.y}px`
    measureLayer.classList.toggle('is-preview', options.preview)
    setHidden(measureLayer, false)
  }

  function clearMeasure(): void {
    measureStart = null
    measureCurrent = null
    measurement = null
    setHidden(measureLayer, true)
    measureLayer.classList.remove('is-preview')
  }

  function handleMeasureClick(event: PointerEvent): void {
    const point = measureAt({ x: event.clientX, y: event.clientY })
    if (!measureStart) {
      measurement = null
      measureStart = point
      measureCurrent = point
      drawMeasurement(measureStart, point, { preview: true })
      return
    }
    const end = point
    measurement = measureBetween(measureStart, end)
    measureStart = null
    measureCurrent = null
    drawMeasurement(measurement.a, measurement.b, { preview: false })
  }

  function updateMeasurePreview(event: PointerEvent): void {
    if (mode !== 'measure') return
    if (!measureStart) {
      if (!measurement) {
        const point = measureAt({ x: event.clientX, y: event.clientY })
        measureDotA.style.left = `${layoutToOverlay(point).x}px`
        measureDotA.style.top = `${layoutToOverlay(point).y}px`
        measureDotB.style.left = `${layoutToOverlay(point).x}px`
        measureDotB.style.top = `${layoutToOverlay(point).y}px`
        measureLine.style.width = '0px'
        measureH.style.width = '0px'
        measureV.style.height = '0px'
        setText(measureLabel, '点击选择起点')
        const overlay = layoutToOverlay(point)
        measureLabel.style.left = `${overlay.x}px`
        measureLabel.style.top = `${overlay.y}px`
        setHidden(measureLayer, false)
        measureLayer.classList.add('is-preview')
      }
      return
    }
    const point = measureAt({ x: event.clientX, y: event.clientY })
    measureCurrent = point
    drawMeasurement(measureStart, point, { preview: true })
  }

  // ── 放大镜 ──────────────────────────────────────────────────────────
  function positiveBackground(element: HTMLElement): string {
    let cursor: Element | null = element
    while (cursor) {
      const color = getComputedStyle(cursor).backgroundColor
      if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color
      cursor = cursor.parentElement
    }
    return 'rgb(255, 255, 255)'
  }

  function ensureLoupeClone(source: HTMLElement, doc: DesignDocument): void {
    if (loupeCache && loupeCache.source === source && loupeCache.version === doc.version) return
    const layoutWidth = source.getBoundingClientRect().width / scale()
    const clone = source.cloneNode(true) as HTMLElement
    clone.classList.remove('is-hover', 'is-selected', 'is-locate-target', 'is-entering', 'just-changed')
    clone.querySelectorAll<HTMLElement>('.is-hover, .is-selected, .is-locate-target, .is-entering, .just-changed').forEach(
      (element) => {
        element.classList.remove('is-hover', 'is-selected', 'is-locate-target', 'is-entering', 'just-changed')
      }
    )
    clone.querySelectorAll<HTMLElement>('[tabindex]').forEach((element) => element.removeAttribute('tabindex'))
    clone.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      input.readOnly = true
      input.tabIndex = -1
    })
    clone.setAttribute('aria-hidden', 'true')
    clone.style.pointerEvents = 'none'
    // 克隆体不是画布节点：去掉会与真实节点重名的 data-* 标记，
    // 避免外部脚本（或测试）按 data-did 查询时命中两份。
    const markers = ['data-did', 'data-node', 'data-type', 'data-locked', 'data-edited']
    for (const marker of markers) clone.removeAttribute(marker)
    clone.querySelectorAll<HTMLElement>(markers.join(', ')).forEach((element) => {
      for (const marker of markers) element.removeAttribute(marker)
    })
    // 克隆体脱离原来的包含块：把自身定位钉回 holder 原点，否则帧内绝对定位的
    // 节点会带着自己的 left/top 跑出镜框（放大镜里只剩一片背景色）。
    clone.style.position = 'absolute'
    clone.style.left = '0'
    clone.style.top = '0'
    clone.style.margin = '0'
    clone.style.width = `${layoutWidth}px`
    loupeHolder.replaceChildren(clone)
    loupeHolder.style.width = `${layoutWidth}px`
    loupeCache = { source, version: doc.version }
  }

  function updateLoupe(event: PointerEvent): void {
    if (!loupeOn) return
    const doc = deps.getDoc()
    const source = sourceElementOf(event) ?? deps.page
    if (!doc) return
    ensureLoupeClone(source, doc)

    const client = { x: event.clientX, y: event.clientY }
    const layout = clientToLayout(client)
    const rect = source.getBoundingClientRect()
    const currentScale = scale()
    const offsetX = (event.clientX - rect.left) / currentScale
    const offsetY = (event.clientY - rect.top) / currentScale
    loupeHolder.style.transform = `translate(${LOUPE_SIZE / 2 - offsetX * LOUPE_ZOOM}px, ${
      LOUPE_SIZE / 2 - offsetY * LOUPE_ZOOM
    }px) scale(${LOUPE_ZOOM})`

    const computed = getComputedStyle(source)
    const layoutWidth = rect.width / currentScale
    const layoutHeight = rect.height / currentScale
    setText(loupeRows.point, `${Math.round(layout.x)}, ${Math.round(layout.y)}`)
    setText(loupeRows.did, source.dataset.did ?? '(page)')
    setText(loupeRows.size, `${Math.round(layoutWidth)} × ${Math.round(layoutHeight)} px`)
    setText(loupeRows.bg, positiveBackground(source))
    setText(loupeRows.color, computed.color || '—')

    const stage = deps.stage.getBoundingClientRect()
    const offset = 24
    let left = overlayPointOf(client).x + offset
    let top = overlayPointOf(client).y + offset
    const overlayLeft = overlayPointOf({ x: stage.left, y: stage.top })
    if (left + 280 > overlayLeft.x + stage.width) left -= 280 + offset * 2
    if (top + 320 > overlayLeft.y + stage.height) top -= 320 + offset * 2
    loupe.style.left = `${Math.max(overlayLeft.x + 8, left)}px`
    loupe.style.top = `${Math.max(overlayLeft.y + 8, top)}px`
    setHidden(loupe, false)
  }

  function toggleLoupe(): boolean {
    loupeOn = !loupeOn
    if (!loupeOn) {
      setHidden(loupe, true)
      loupeCache = null
    }
    deps.onLoupeChange(loupeOn)
    updateHint()
    return loupeOn
  }

  function isLoupeOn(): boolean {
    return loupeOn
  }

  // ── 模式 ────────────────────────────────────────────────────────────
  function setMode(next: CanvasMode): void {
    if (mode === next) {
      updateHint()
      return
    }
    endDrag()
    clearLocate()
    clearMeasure()
    mode = next
    deps.stage.classList.toggle('is-locating', next === 'locate')
    deps.stage.classList.toggle('is-measuring', next === 'measure')
    deps.onModeChange(next)
    updateHint()
  }

  function getMode(): CanvasMode {
    return mode
  }

  function cancel(): void {
    if (drag) endDrag()
    if (locate || locatePreview) clearLocate()
    if (measurement || measureStart) clearMeasure()
    if (mode !== 'select') setMode('select')
    updateHint()
  }

  // ── 事件 ────────────────────────────────────────────────────────────
  function handlePointerDown(event: PointerEvent): void {
    const target = event.target as Element | null
    if (!target) return
    if (target.closest(CANVAS_UI)) return
    event.preventDefault()
    event.stopPropagation()

    if (mode === 'locate') {
      commitLocateClick(event)
      return
    }
    if (mode === 'measure') {
      handleMeasureClick(event)
      return
    }
    beginPointerDrag(event)
  }

  function handlePointerMove(event: PointerEvent): void {
    if (mode === 'locate' && !locate) {
      updateLocatePreview(event)
      return
    }
    if (mode === 'measure') {
      updateMeasurePreview(event)
      return
    }
    const nodeElement = sourceElementOf(event)
    if (nodeElement) {
      const id = nodeElement.dataset.did ?? null
      setHover(id)
    } else {
      setHover(null)
    }
  }

  function handleWindowPointerMove(event: PointerEvent): void {
    if (drag) {
      updateDrag(event)
      return
    }
    if (loupeOn) updateLoupe(event)
  }

  function handleWindowPointerUp(event: PointerEvent): void {
    if (drag && event.pointerId === drag.pointerId) finishDrag()
  }

  function handlePointerLeave(): void {
    setHover(null)
    if (loupeOn) setHidden(loupe, true)
    if (mode === 'locate' && !locate) {
      setHidden(locatePin, true)
      locatePreview = null
    }
  }

  // 捕获阶段拦截页面自身行为（定位模式尤其重要）
  disposers.push(
    on<PointerEvent>(deps.stage, 'pointerover', (event) => {
      if (isCanvasUi(event)) return
      if (mode === 'locate') {
        updateLocatePreview(event)
        return
      }
      const nodeElement = sourceElementOf(event)
      setHover(nodeElement?.dataset.did ?? null)
    }),
    on<PointerEvent>(deps.stage, 'pointerdown', handlePointerDown, true),
    on<PointerEvent>(deps.stage, 'pointermove', handlePointerMove),
    on<PointerEvent>(window, 'pointermove', handleWindowPointerMove),
    on<PointerEvent>(window, 'pointerup', handleWindowPointerUp),
    on<PointerEvent>(window, 'pointercancel', handleWindowPointerUp),
    on<PointerEvent>(deps.stage, 'pointerleave', handlePointerLeave),
    on<Event>(deps.stage, 'click', (event) => {
      if (isCanvasUi(event)) return
      event.preventDefault()
      event.stopPropagation()
    }, true),
    on<Event>(deps.stage, 'mousedown', (event) => {
      if (isCanvasUi(event)) return
      event.preventDefault()
    }, true),
    on<Event>(deps.stage, 'dblclick', (event) => {
      if (isCanvasUi(event)) return
      event.preventDefault()
      event.stopPropagation()
    }, true),
    on<Event>(deps.stage, 'submit', (event) => event.preventDefault(), true),
    on<Event>(deps.stage, 'dragstart', (event) => event.preventDefault(), true),
    on<KeyboardEvent>(deps.stage, 'keydown', (event) => {
      if (isCanvasUi(event)) return
      event.preventDefault()
      event.stopPropagation()
    }, true),
    on<MouseEvent>(locateYes, 'click', () => confirmLocate()),
    on<MouseEvent>(locateNo, 'click', () => clearLocate()),
    on<MouseEvent>(loupe, 'click', (event) => event.stopPropagation())
  )

  // ── 远端光标 / 刷新 ─────────────────────────────────────────────────
  function showRemoteCursor(cursor: { actor: string; x: number; y: number; state: string }): void {
    const existing = remoteCursors.get(cursor.actor)
    let entry = existing
    if (!entry) {
      const element = el('div', { className: 'remote-cursor' })
      const label = el('span', { className: 'remote-cursor__label' })
      element.append(el('span', { className: 'remote-cursor__dot' }), label)
      cursorLayer.append(element)
      entry = { element, timer: 0 }
      remoteCursors.set(cursor.actor, entry)
    }
    if (entry.timer) window.clearTimeout(entry.timer)
    const overlay = layoutToOverlay({ x: cursor.x, y: cursor.y })
    entry.element.style.left = `${overlay.x}px`
    entry.element.style.top = `${overlay.y}px`
    setText(entry.element.querySelector<HTMLElement>('.remote-cursor__label')!, `${cursor.actor} · ${cursor.state}`)
    entry.element.hidden = false
    entry.timer = window.setTimeout(() => {
      entry!.element.hidden = true
    }, REMOTE_CURSOR_TTL)
  }

  function refresh(): void {
    snapBaseCache = null
    loupeCache = null
    // 克隆是按旧文档/旧缩放做的：先藏起来，等下一次鼠标移动重建
    if (loupeOn) setHidden(loupe, true)
    const render = deps.getRender()
    if (!render) return
    if (selectedId) {
      const element = render.get(selectedId)
      if (!element) {
        select(null)
      } else {
        element.classList.add('is-selected')
      }
    }
    if (hoverId && !render.get(hoverId)) hoverId = null
    if (hoverId) render.get(hoverId)?.classList.add('is-hover')
    if (locate) {
      if (!render.get(locate.targetId)) {
        clearLocate()
      } else {
        positionLocatePin(locate.point, locate)
        applyLocateTargetClass(locate.targetId)
      }
    }
    if (locatePreview && mode === 'locate' && !locate) {
      positionLocatePin(locatePreview, null)
    }
    if (measurement) {
      drawMeasurement(measurement.a, measurement.b, { preview: false })
    } else if (measureStart && measureCurrent) {
      drawMeasurement(measureStart, measureCurrent, { preview: true })
    }
    updateHint()
  }

  function destroy(): void {
    for (const dispose of disposers) dispose()
    disposers.length = 0
    for (const entry of remoteCursors.values()) {
      if (entry.timer) window.clearTimeout(entry.timer)
      entry.element.remove()
    }
    remoteCursors.clear()
    hint.remove()
    snapDots.remove()
    guideV.remove()
    guideH.remove()
    ghost.remove()
    locatePin.remove()
    locateConfirm.remove()
    measureLayer.remove()
    loupe.remove()
    cursorLayer.remove()
  }

  updateHint()

  return {
    select,
    getSelectedId: () => selectedId,
    setMode,
    getMode,
    toggleLoupe,
    isLoupeOn,
    refresh,
    cancel,
    showRemoteCursor,
    destroy
  }
}
