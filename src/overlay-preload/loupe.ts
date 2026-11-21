/**
 * 设计放大镜（M 开关）。
 *
 * 光学部分不用截屏 / canvas：把鼠标下的元素 `cloneNode(true)` 到 shadow 内部，
 * 递归复制计算样式（shadow 内拿不到页面样式表），再用 `transform: scale(2.5)`
 * 实现局部放大；鼠标在元素内的位置映射到放大镜圆心。
 *
 * 旁边读数：视口坐标、`data-did` / 标签、元素尺寸、背景色 / 文字色。
 * 放大镜本身 `pointer-events: none`；滚动 / 窗口变化 / 失焦时自动隐藏。
 */
import {
  clamp,
  elementTargetId,
  formatPointReadout,
  formatSize,
  normalizeColor
} from './design-utils'
import type { Point } from './design-utils'

const HOST_ID = '__duplex_loupe_layer'
const Z_INDEX = 2147483450
const FONT_STACK = "-apple-system, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif"
const SIZE = 220
const SCALE = 2.5
const MAX_NODES = 500
const MIN_BUILD_INTERVAL = 70

/** 深克隆时逐节点复制的计算样式（页面样式表进不了 shadow，只能内联复制）。 */
const STYLE_PROPS: readonly string[] = [
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'box-sizing',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'background-color',
  'background-image',
  'background-position',
  'background-size',
  'background-repeat',
  'background-clip',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration-line',
  'text-transform',
  'white-space',
  'word-break',
  'overflow-wrap',
  'text-overflow',
  'text-shadow',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'justify-content',
  'align-items',
  'align-content',
  'align-self',
  'gap',
  'row-gap',
  'column-gap',
  'grid-template-columns',
  'grid-template-rows',
  'grid-auto-flow',
  'grid-column',
  'grid-row',
  'opacity',
  'overflow-x',
  'overflow-y',
  'box-shadow',
  'object-fit',
  'object-position',
  'vertical-align',
  'list-style-type',
  'border-collapse',
  'table-layout'
]

const FORBIDDEN_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'LINK',
  'META',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'TEMPLATE',
  'NOSCRIPT'
])

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.loupe {
  position: fixed;
  left: 0;
  top: 0;
  display: none;
  align-items: flex-start;
  gap: 10px;
  pointer-events: none;
  font: 11px/1.45 ${FONT_STACK};
  color: #d7dde5;
}
.loupe.open { display: flex; }
.loupe.flipped { flex-direction: row-reverse; }
.stage {
  position: relative;
  width: ${SIZE}px;
  height: ${SIZE}px;
  border-radius: 50%;
  overflow: hidden;
  background: #0f141a;
  flex: 0 0 auto;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.16),
    0 0 0 7px rgba(9, 13, 18, 0.32);
}
.stage::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12), inset 0 0 42px rgba(0, 0, 0, 0.28);
  pointer-events: none;
}
.scale-wrap {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  transform-origin: 0 0;
  will-change: transform;
}
.clone-root {
  position: absolute !important;
  left: 0 !important;
  top: 0 !important;
  margin: 0 !important;
  transform: none !important;
  pointer-events: none !important;
}
.fallback {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 18px;
  color: #8a97a5;
  text-align: center;
}
.fallback strong { color: #cfd8e2; font-weight: 600; }
.readout {
  min-width: 152px;
  max-width: 240px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(15, 20, 26, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.row { display: flex; justify-content: space-between; gap: 10px; }
.row + .row { margin-top: 2px; }
.k { color: #7d8b99; flex: 0 0 auto; }
.v {
  color: #d7dde5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.target-outline {
  position: fixed;
  display: none;
  border: 1.5px solid rgba(77, 163, 255, 0.95);
  background: rgba(77, 163, 255, 0.06);
  border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.22);
  pointer-events: none;
}
`

export interface LoupeOptions {
  zIndex?: number
}

export interface Loupe {
  toggle(on?: boolean): void
  show(): void
  hide(): void
  isOpen(): boolean
  destroy(): void
}

export function createLoupe(options: LoupeOptions = {}): Loupe {
  if (typeof document === 'undefined') {
    return {
      toggle: () => {},
      show: () => {},
      hide: () => {},
      isOpen: () => false,
      destroy: () => {}
    }
  }
  const parent = document.body ?? document.documentElement
  if (!parent) {
    return {
      toggle: () => {},
      show: () => {},
      hide: () => {},
      isOpen: () => false,
      destroy: () => {}
    }
  }

  document.getElementById(HOST_ID)?.remove()
  const zIndex = options.zIndex ?? Z_INDEX
  const host = document.createElement('div')
  host.id = HOST_ID
  host.setAttribute('data-duplex-design-layer', 'loupe')
  host.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${zIndex};contain:layout style;`
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CSS
  root.appendChild(style)

  const loupeEl = document.createElement('div')
  loupeEl.className = 'loupe'
  const stage = document.createElement('div')
  stage.className = 'stage'
  const scaleWrap = document.createElement('div')
  scaleWrap.className = 'scale-wrap'
  stage.appendChild(scaleWrap)

  const readout = document.createElement('div')
  readout.className = 'readout'
  const pointEl = makeRow(readout, 'x, y')
  const targetEl = makeRow(readout, 'target')
  const sizeEl = makeRow(readout, 'size')
  const bgEl = makeRow(readout, 'bg')
  const fgEl = makeRow(readout, 'text')
  loupeEl.append(stage, readout)

  const outline = document.createElement('div')
  outline.className = 'target-outline'
  root.append(loupeEl, outline)
  parent.appendChild(host)

  let open = false
  let destroyed = false
  let lastMouse: Point | null = null
  let hoverTarget: Element | null = null
  let builtTarget: Element | null = null
  let cloneRoot: Element | null = null
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null
  let lastBuildAt = 0
  let rafId = 0
  let panelWidth = 0
  let panelHeight = 0

  function makeRow(container: HTMLElement, label: string): HTMLElement {
    const row = document.createElement('div')
    row.className = 'row'
    const key = document.createElement('span')
    key.className = 'k'
    key.textContent = label
    const value = document.createElement('span')
    value.className = 'v'
    value.textContent = '—'
    row.append(key, value)
    container.appendChild(row)
    return value
  }

  function nowMs(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  }

  function elementAt(point: Point): Element | null {
    if (typeof document.elementFromPoint !== 'function') return null
    const hit = document.elementFromPoint(point.x, point.y)
    if (!hit) return null
    if (hit === host || host.contains(hit)) return null
    return hit
  }

  function clearClone(): void {
    while (scaleWrap.firstChild) scaleWrap.removeChild(scaleWrap.firstChild)
    cloneRoot = null
    builtTarget = null
  }

  function clearRebuildTimer(): void {
    if (rebuildTimer !== null) {
      clearTimeout(rebuildTimer)
      rebuildTimer = null
    }
  }

  function renderFallback(target: Element): void {
    clearClone()
    const fallback = document.createElement('div')
    fallback.className = 'fallback'
    const strong = document.createElement('strong')
    strong.textContent = elementTargetId({
      did: target.getAttribute('data-did'),
      id: target.getAttribute('id'),
      tag: target.tagName
    })
    const hint = document.createElement('span')
    hint.textContent = '元素过大，仅显示信息'
    fallback.append(strong, hint)
    scaleWrap.appendChild(fallback)
    builtTarget = target
  }

  function sanitizeAndCopy(src: Element, dst: Element, budget: { left: number }): void {
    if (budget.left <= 0) {
      dst.remove()
      return
    }
    budget.left -= 1
    if (FORBIDDEN_TAGS.has(dst.tagName)) {
      dst.remove()
      return
    }

    const attrs = Array.from(dst.attributes)
    for (const attr of attrs) {
      const name = attr.name.toLowerCase()
      if (
        name === 'id' ||
        name === 'name' ||
        name === 'autofocus' ||
        name === 'tabindex' ||
        name === 'contenteditable' ||
        name.startsWith('on')
      ) {
        dst.removeAttribute(attr.name)
      }
    }

    const computed = getComputedStyle(src)
    const targetStyle = (dst as HTMLElement).style
    for (const prop of STYLE_PROPS) {
      const value = computed.getPropertyValue(prop)
      if (value) targetStyle.setProperty(prop, value)
    }
    targetStyle.setProperty('animation', 'none')
    targetStyle.setProperty('transition', 'none')

    const tag = dst.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      ;(dst as HTMLInputElement).value = (src as HTMLInputElement).value
      if (tag === 'INPUT') {
        ;(dst as HTMLInputElement).checked = (src as HTMLInputElement).checked
      }
    } else if (tag === 'SELECT') {
      ;(dst as HTMLSelectElement).selectedIndex = (src as HTMLSelectElement).selectedIndex
    }

    const srcChildren = Array.from(src.children)
    const dstChildren = Array.from(dst.children)
    const count = Math.min(srcChildren.length, dstChildren.length)
    for (let i = 0; i < count; i++) {
      const srcChild = srcChildren[i]
      const dstChild = dstChildren[i]
      if (srcChild && dstChild) sanitizeAndCopy(srcChild, dstChild, budget)
    }
  }

  function buildClone(target: Element): void {
    clearClone()
    lastBuildAt = nowMs()
    const rect = target.getBoundingClientRect()
    if (
      target === document.body ||
      target === document.documentElement ||
      rect.width < 1 ||
      rect.height < 1
    ) {
      renderFallback(target)
      measurePanel()
      return
    }

    const clone = target.cloneNode(true) as Element
    sanitizeAndCopy(target, clone, { left: MAX_NODES })
    const cloneStyle = (clone as HTMLElement).style
    cloneStyle.setProperty('position', 'absolute', 'important')
    cloneStyle.setProperty('left', '0', 'important')
    cloneStyle.setProperty('top', '0', 'important')
    cloneStyle.setProperty('margin', '0', 'important')
    cloneStyle.setProperty('transform', 'none', 'important')
    cloneStyle.setProperty('box-sizing', 'border-box', 'important')
    cloneStyle.setProperty('width', `${Math.max(1, rect.width)}px`, 'important')
    cloneStyle.setProperty('height', `${Math.max(1, rect.height)}px`, 'important')
    cloneRoot = clone
    scaleWrap.appendChild(clone)
    builtTarget = target
    measurePanel()
  }

  function scheduleClone(target: Element | null): void {
    if (target === builtTarget) return
    clearRebuildTimer()
    const wait = Math.max(0, MIN_BUILD_INTERVAL - (nowMs() - lastBuildAt))
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null
      if (!open || destroyed || !hoverTarget) return
      buildClone(hoverTarget)
    }, wait)
  }

  function measurePanel(): void {
    panelWidth = 0
    panelHeight = 0
  }

  function ensurePanelMetrics(): void {
    if (panelWidth > 0) return
    panelWidth = loupeEl.offsetWidth || SIZE + 10 + 160
    panelHeight = loupeEl.offsetHeight || SIZE
  }

  function updateTransform(cursor: Point): void {
    if (!builtTarget || builtTarget !== hoverTarget || !cloneRoot) return
    const rect = builtTarget.getBoundingClientRect()
    const width = Math.max(1, rect.width)
    const height = Math.max(1, rect.height)
    const localX = clamp(cursor.x - rect.left, 0, width)
    const localY = clamp(cursor.y - rect.top, 0, height)
    scaleWrap.style.transform = `translate(${(SIZE / 2 - localX * SCALE).toFixed(
      2
    )}px, ${(SIZE / 2 - localY * SCALE).toFixed(2)}px) scale(${SCALE})`
  }

  function updateOutline(target: Element | null): void {
    if (!target || target === document.body || target === document.documentElement) {
      outline.style.display = 'none'
      return
    }
    const rect = target.getBoundingClientRect()
    outline.style.display = 'block'
    outline.style.left = `${rect.left.toFixed(2)}px`
    outline.style.top = `${rect.top.toFixed(2)}px`
    outline.style.width = `${rect.width.toFixed(2)}px`
    outline.style.height = `${rect.height.toFixed(2)}px`
  }

  function updateReadout(cursor: Point): void {
    pointEl.textContent = formatPointReadout(cursor)
    if (!hoverTarget) {
      targetEl.textContent = '—'
      sizeEl.textContent = '—'
      bgEl.textContent = '—'
      fgEl.textContent = '—'
      return
    }
    targetEl.textContent = elementTargetId({
      did: hoverTarget.getAttribute('data-did'),
      id: hoverTarget.getAttribute('id'),
      tag: hoverTarget.tagName
    })
    targetEl.setAttribute('title', targetEl.textContent ?? '')
    const rect = hoverTarget.getBoundingClientRect()
    sizeEl.textContent = formatSize(rect.width, rect.height)
    try {
      const computed = getComputedStyle(hoverTarget)
      bgEl.textContent = normalizeColor(computed.backgroundColor)
      fgEl.textContent = normalizeColor(computed.color)
    } catch {
      bgEl.textContent = '—'
      fgEl.textContent = '—'
    }
  }

  function positionPanel(cursor: Point): void {
    ensurePanelMetrics()
    const margin = 12
    const gap = 18
    const width = panelWidth || SIZE + 170
    const height = panelHeight || SIZE
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const flipped = cursor.x + gap + width > viewportWidth - margin
    loupeEl.classList.toggle('flipped', flipped)
    const left = flipped ? cursor.x - gap - width : cursor.x + gap
    loupeEl.style.left = `${clamp(left, margin, Math.max(margin, viewportWidth - width - margin)).toFixed(2)}px`
    loupeEl.style.top = `${clamp(
      cursor.y + gap,
      margin,
      Math.max(margin, viewportHeight - height - margin)
    ).toFixed(2)}px`
  }

  function render(): void {
    if (!open || destroyed) return
    const cursor =
      lastMouse ??
      ({ x: window.innerWidth / 2, y: window.innerHeight / 2 } satisfies Point)
    const target = elementAt(cursor)
    hoverTarget = target
    if (target !== builtTarget) scheduleClone(target)
    if (!hoverTarget && builtTarget) {
      clearClone()
    }
    positionPanel(cursor)
    updateReadout(cursor)
    updateOutline(target)
    updateTransform(cursor)
  }

  function scheduleRender(): void {
    if (rafId !== 0) return
    rafId = window.requestAnimationFrame(() => {
      rafId = 0
      render()
    })
  }

  function onMouseMove(event: MouseEvent): void {
    lastMouse = { x: event.clientX, y: event.clientY }
    if (!open) return
    scheduleRender()
  }

  function onScroll(): void {
    if (open) hide()
  }

  function onResize(): void {
    measurePanel()
    if (open) hide()
  }

  function onBlur(): void {
    if (open) hide()
  }

  function hide(): void {
    if (!open) return
    open = false
    loupeEl.classList.remove('open')
    clearRebuildTimer()
    clearClone()
    hoverTarget = null
    outline.style.display = 'none'
    measurePanel()
  }

  function show(): void {
    if (destroyed || open) return
    open = true
    loupeEl.classList.add('open')
    measurePanel()
    render()
  }

  const onMouseMoveListener = (event: MouseEvent): void => onMouseMove(event)
  const onScrollListener = (): void => onScroll()
  const onResizeListener = (): void => onResize()
  const onBlurListener = (): void => onBlur()
  window.addEventListener('mousemove', onMouseMoveListener, { capture: true, passive: true })
  window.addEventListener('scroll', onScrollListener, { capture: true, passive: true })
  window.addEventListener('resize', onResizeListener)
  window.addEventListener('blur', onBlurListener)

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    open = false
    if (rafId !== 0) {
      window.cancelAnimationFrame(rafId)
      rafId = 0
    }
    clearRebuildTimer()
    window.removeEventListener('mousemove', onMouseMoveListener, { capture: true })
    window.removeEventListener('scroll', onScrollListener, { capture: true })
    window.removeEventListener('resize', onResizeListener)
    window.removeEventListener('blur', onBlurListener)
    clearClone()
    host.remove()
  }

  return {
    toggle(on?: boolean): void {
      const next = on === undefined ? !open : !!on
      if (next) show()
      else hide()
    },
    show,
    hide,
    isOpen: () => open,
    destroy
  }
}
