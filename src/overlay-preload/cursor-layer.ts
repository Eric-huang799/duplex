/**
 * 多 agent 光标层。
 *
 * 一个独立的 shadow host（`position: fixed; inset: 0; pointer-events: none`），
 * 每个 actor 一个光标：稳定颜色（12 色调色板哈希）、短标签、状态可视化。
 *
 * 状态一律由调用方给出（`setCursor` / `moveTo` / `click`），本层**不**在动画
 * 结束后自己编一个“完成”状态：blocked / paused / failed 永远不会有成功暗示。
 *
 * 移动用 requestAnimationFrame + easeInOutCubic 走轨迹；同一 actor 的新目标
 * 从当前位置改向（中途改向）。`prefers-reduced-motion` 下直接定位。
 */
import {
  actorColor,
  actorLabel,
  clamp,
  isCursorState,
  isMotionDone,
  layoutLabels,
  makeMotion,
  motionPoint,
  parkOnEdge
} from './design-utils'
import type { CursorState, LabelBox, Motion, Point, Viewport } from './design-utils'

export type { CursorState } from './design-utils'

const HOST_ID = '__duplex_cursor_layer'
const DEFAULT_DURATION = 600
const MIN_DURATION = 80
const MAX_DURATION = 5000
const TAG_LEFT = 14
const TAG_TOP = 12
const FONT_STACK = "-apple-system, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif"
const Z_INDEX = 2147483600

export interface CursorLayerOptions {
  zIndex?: number
  /** 覆盖系统偏好（测试/降级用）；不传则跟随 matchMedia。 */
  reducedMotion?: boolean
}

export interface CursorLayer {
  setCursor(actor: string, state: CursorState): void
  moveTo(actor: string, x: number, y: number, durationMs?: number): void
  click(actor: string, x: number, y: number): void
  remove(actor: string): void
  destroy(): void
}

interface Actor {
  id: string
  el: HTMLDivElement
  tag: HTMLDivElement
  bubble: HTMLDivElement
  bubbleText: HTMLSpanElement
  nameEl: HTMLSpanElement
  stateEl: HTMLSpanElement
  color: string
  state: CursorState | 'idle'
  pos: Point
  motion: Motion | null
  /** paused 前的位置，恢复时用。 */
  restore: Point | null
  positioned: boolean
  tagWidth: number
  tagHeight: number
  dirty: boolean
  /** 最近一次显式 click() 的时间，避免 clicking 状态与 click() 重复出涟漪。 */
  lastClickAt: number
  /** true = 状态由调用方显式设置；false = 本层因 moveTo 临时标记的 moving。 */
  stateFromCaller: boolean
}

interface ActorNode {
  el: HTMLDivElement
  tag: HTMLDivElement
  bubble: HTMLDivElement
  bubbleText: HTMLSpanElement
  nameEl: HTMLSpanElement
  stateEl: HTMLSpanElement
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.cur {
  position: fixed;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  opacity: 0;
  transform: translate3d(-200px, -200px, 0);
  transition: opacity 140ms ease;
  pointer-events: none;
  will-change: transform;
  font: 11px/1.35 ${FONT_STACK};
  color: #e8eef5;
  --c: #4da3ff;
}
.cur.on { opacity: 1; }
.cur[data-state='blocked'], .cur[data-state='paused'] { opacity: 0.5; }
.cur[data-state='paused'] { filter: grayscale(1); }

.pointer {
  position: absolute;
  left: -2px;
  top: -2px;
  width: 18px;
  height: 22px;
  transform-origin: 2px 2px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35));
}
.pointer svg { display: block; width: 100%; height: 100%; }
.pointer svg path {
  fill: var(--c);
  stroke: rgba(10, 14, 18, 0.72);
  stroke-width: 1;
  paint-order: stroke fill;
}
.cur[data-state='thinking'] .pointer { animation: dsl-breathe 1.7s ease-in-out infinite; }
.cur[data-state='moving'] .pointer { filter: drop-shadow(0 0 5px var(--c)); }
.cur.shake .pointer { animation: dsl-shake 220ms ease-in-out 2; }

.ibeam {
  display: none;
  position: absolute;
  left: 17px;
  top: -3px;
  width: 2px;
  height: 19px;
  border-radius: 1px;
  background: #e8eef5;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.5);
}
.cur[data-state='typing'] .ibeam { display: block; }

.alert {
  display: none;
  position: absolute;
  left: 13px;
  top: -5px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ff5d5d;
  box-shadow: 0 0 0 2px rgba(255, 93, 93, 0.25);
}
.cur[data-state='failed'] .alert { display: block; }

.tag {
  position: absolute;
  left: ${TAG_LEFT}px;
  top: ${TAG_TOP}px;
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 172px;
  padding: 2px 6px;
  border-radius: 5px;
  background: rgba(15, 20, 26, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
  white-space: nowrap;
  pointer-events: none;
}
.tag .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c);
  flex: 0 0 auto;
}
.tag .name { max-width: 96px; overflow: hidden; text-overflow: ellipsis; }
.tag .state { color: #9aa7b4; }
.tag .state:empty { display: none; }

.cur[data-state='blocked'] .tag { border-color: rgba(232, 184, 75, 0.55); }
.cur[data-state='blocked'] .tag .state { color: #e8c97f; }
.cur[data-state='paused'] .tag { background: rgba(72, 78, 86, 0.82); border-color: rgba(255, 255, 255, 0.12); }
.cur[data-state='paused'] .tag .dot { background: #9aa7b4; }
.cur[data-state='failed'] .tag .dot { background: #ff5d5d; }
.cur[data-state='failed'] .tag .state { color: #ff9b9b; }

.bubble {
  display: none;
  position: absolute;
  left: ${TAG_LEFT}px;
  top: ${TAG_TOP}px;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 5px;
  background: rgba(15, 20, 26, 0.9);
  border: 1px solid rgba(232, 184, 75, 0.45);
  color: #e8c97f;
  white-space: nowrap;
  pointer-events: none;
}
.cur[data-state='blocked'] .bubble { display: flex; }
.cur[data-state='typing'] .bubble { display: flex; border-color: rgba(255, 255, 255, 0.16); color: #cfd8e2; }
.dots { display: none; gap: 2px; align-items: center; }
.cur[data-state='typing'] .dots { display: inline-flex; }
.dots i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  animation: dsl-typing 1.05s ease-in-out infinite;
}
.dots i:nth-child(2) { animation-delay: 0.15s; }
.dots i:nth-child(3) { animation-delay: 0.3s; }

.fx { position: fixed; inset: 0; pointer-events: none; }
.ripple {
  position: fixed;
  left: 0;
  top: 0;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: 50%;
  border: 2px solid var(--c);
  animation: dsl-ripple 320ms cubic-bezier(0.2, 0.6, 0.35, 1) forwards;
  pointer-events: none;
}

@keyframes dsl-breathe {
  0%, 100% { transform: scale(0.92); }
  50% { transform: scale(1.08); }
}
@keyframes dsl-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-2px); }
  75% { transform: translateX(2px); }
}
@keyframes dsl-typing {
  0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-2px); }
}
@keyframes dsl-ripple {
  from { transform: scale(0.4); opacity: 0.95; }
  to { transform: scale(3.4); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .cur { transition: none; }
  .pointer, .dots i, .bubble { animation: none !important; }
  /* 涟漪保留一次静态反馈（无位移），320ms 后照常移除。 */
  .ripple { animation: none !important; opacity: 0.75; transform: scale(1.4); }
}
`

const NOOP: CursorLayer = {
  setCursor: () => {},
  moveTo: () => {},
  click: () => {},
  remove: () => {},
  destroy: () => {}
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeActor(actor: unknown): string {
  const raw = typeof actor === 'string' ? actor.trim() : ''
  return (raw || 'agent').slice(0, 64)
}

function pointerSvg(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 18 22')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '22')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', 'M2 1.5 L2 17.2 L6.1 13.4 L9.1 20.4 L11.5 19.4 L8.5 12.5 L14.2 12.5 Z')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  return svg
}

export function createCursorLayer(options: CursorLayerOptions = {}): CursorLayer {
  if (typeof document === 'undefined') return NOOP
  const parent = document.body ?? document.documentElement
  if (!parent) return NOOP

  const previous = document.getElementById(HOST_ID)
  if (previous) previous.remove()

  const zIndex = options.zIndex ?? Z_INDEX
  const host = document.createElement('div')
  host.id = HOST_ID
  host.setAttribute('data-duplex-design-layer', 'cursor')
  host.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${zIndex};contain:layout style;`

  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CSS
  root.appendChild(style)
  const fx = document.createElement('div')
  fx.className = 'fx'
  root.appendChild(fx)
  parent.appendChild(host)

  const actors = new Map<string, Actor>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let destroyed = false
  let rafId = 0

  const box =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
  const reducedMotion = {
    value: options.reducedMotion ?? box?.matches ?? false
  }
  const onMotionPreference = (event: MediaQueryListEvent): void => {
    if (options.reducedMotion === undefined) reducedMotion.value = event.matches
  }
  if (options.reducedMotion === undefined) box?.addEventListener('change', onMotionPreference)

  const now = (): number =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()

  const viewportSize = (): Viewport => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0
  })

  function after(ms: number, fn: () => void): void {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
  }

  function applyPosition(actor: Actor): void {
    actor.el.style.transform = `translate3d(${actor.pos.x.toFixed(2)}px, ${actor.pos.y.toFixed(
      2
    )}px, 0)`
  }

  function measureTag(actor: Actor): void {
    actor.tagWidth = actor.tag.offsetWidth || 96
    actor.tagHeight = actor.tag.offsetHeight || 20
    actor.dirty = false
  }

  function layoutTags(): void {
    if (destroyed || actors.size === 0) return
    const boxes: LabelBox[] = []
    for (const actor of actors.values()) {
      if (actor.dirty) measureTag(actor)
      boxes.push({
        id: actor.id,
        x: actor.pos.x + TAG_LEFT,
        y: actor.pos.y + TAG_TOP,
        width: actor.tagWidth,
        height: actor.tagHeight
      })
    }
    const placements = layoutLabels(boxes, { viewport: viewportSize(), gap: 4, margin: 6 })
    for (const placement of placements) {
      const actor = actors.get(placement.id)
      if (!actor) continue
      actor.tag.style.transform = `translate(${placement.dx}px, ${placement.dy}px)`
      actor.bubble.style.transform = `translate(${placement.dx}px, ${
        placement.dy + actor.tagHeight + 4
      }px)`
    }
  }

  function schedule(): void {
    if (destroyed || rafId !== 0) return
    if (typeof window.requestAnimationFrame !== 'function') return
    rafId = window.requestAnimationFrame(tick)
  }

  function tick(): void {
    rafId = 0
    if (destroyed) return
    let animating = false
    const current = now()
    for (const actor of actors.values()) {
      if (!actor.motion) continue
      const motion = actor.motion
      actor.pos = motionPoint(motion, current)
      if (isMotionDone(motion, current)) {
        actor.pos = { ...motion.to }
        actor.motion = null
        // 本层临时标记的 moving 到达后回到 idle；调用方显式给的状态原样保留，
        // 绝不自行改成“完成/成功”之类。
        if (!actor.stateFromCaller && actor.state === 'moving') {
          actor.state = 'idle'
          actor.el.dataset.state = 'idle'
          actor.dirty = true
        }
      } else {
        animating = true
      }
      applyPosition(actor)
    }
    layoutTags()
    if (animating) schedule()
  }

  function startMotion(actor: Actor, target: Point, durationMs: number): void {
    if (reducedMotion.value || durationMs <= 0) {
      actor.motion = null
      actor.pos = { ...target }
      applyPosition(actor)
      layoutTags()
      return
    }
    actor.motion = makeMotion(actor.pos, target, now(), durationMs)
    schedule()
  }

  function createActorNode(id: string, color: string): ActorNode {
    const el = document.createElement('div')
    el.className = 'cur'
    el.dataset.state = 'idle'
    el.style.setProperty('--c', color)

    const pointer = document.createElement('div')
    pointer.className = 'pointer'
    pointer.appendChild(pointerSvg())

    const ibeam = document.createElement('div')
    ibeam.className = 'ibeam'

    const alert = document.createElement('div')
    alert.className = 'alert'

    const tag = document.createElement('div')
    tag.className = 'tag'
    const dot = document.createElement('span')
    dot.className = 'dot'
    const nameEl = document.createElement('span')
    nameEl.className = 'name'
    nameEl.textContent = actorLabel(id)
    const stateEl = document.createElement('span')
    stateEl.className = 'state'
    tag.append(dot, nameEl, stateEl)

    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    const bubbleText = document.createElement('span')
    bubbleText.className = 'btext'
    const dots = document.createElement('span')
    dots.className = 'dots'
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('i'))
    bubble.append(bubbleText, dots)

    el.append(pointer, ibeam, alert, tag, bubble)
    return { el, tag, bubble, bubbleText, nameEl, stateEl }
  }

  function ensureActor(actorName: unknown): Actor | null {
    if (destroyed) return null
    const id = normalizeActor(actorName)
    const existing = actors.get(id)
    if (existing) return existing
    const color = actorColor(id)
    const node = createActorNode(id, color)
    root.appendChild(node.el)
    const actor: Actor = {
      id,
      ...node,
      color,
      state: 'idle',
      pos: { x: 0, y: 0 },
      motion: null,
      restore: null,
      positioned: false,
      tagWidth: 0,
      tagHeight: 0,
      dirty: true,
      lastClickAt: Number.NEGATIVE_INFINITY,
      stateFromCaller: false
    }
    actors.set(id, actor)
    return actor
  }

  function applyState(actor: Actor, state: CursorState | 'idle', fromCaller: boolean): void {
    const previous = actor.state
    actor.state = state
    actor.stateFromCaller = fromCaller
    actor.el.dataset.state = state
    actor.stateEl.textContent =
      state === 'blocked' || state === 'paused' || state === 'failed' ? state : ''
    actor.bubbleText.textContent = state === 'blocked' ? '等待中' : ''
    actor.dirty = true

    if (state === 'failed') {
      actor.el.classList.remove('shake')
      // 强制回流，保证同一个 actor 连续两次 failed 也能重放轻震
      void actor.el.offsetWidth
      actor.el.classList.add('shake')
      after(520, () => actor.el.classList.remove('shake'))
    }

    // clicking 的可视化就是一次 320ms 涟漪；刚刚 click() 过就不再重复出。
    if (
      state === 'clicking' &&
      previous !== 'clicking' &&
      actor.positioned &&
      now() - actor.lastClickAt > 320
    ) {
      spawnRipple(actor.pos.x, actor.pos.y, actor.color)
    }

    if (state === 'paused' && previous !== 'paused') {
      actor.restore = { ...actor.pos }
      if (actor.positioned) startMotion(actor, parkOnEdge(actor.pos, viewportSize()), 460)
    } else if (previous === 'paused' && state !== 'paused' && actor.restore) {
      const restore = actor.restore
      actor.restore = null
      startMotion(actor, restore, 420)
    }
    layoutTags()
  }

  function spawnRipple(x: number, y: number, color: string): void {
    const ripple = document.createElement('div')
    ripple.className = 'ripple'
    ripple.style.setProperty('--c', color)
    ripple.style.left = `${x.toFixed(2)}px`
    ripple.style.top = `${y.toFixed(2)}px`
    fx.appendChild(ripple)
    let removed = false
    const cleanup = (): void => {
      if (removed) return
      removed = true
      ripple.remove()
    }
    ripple.addEventListener('animationend', cleanup, { once: true })
    after(420, cleanup)
  }

  function moveTo(actorName: unknown, x: number, y: number, durationMs?: number): void {
    const actor = ensureActor(actorName)
    if (!actor) return
    const px = finiteNumber(x)
    const py = finiteNumber(y)
    if (px == null || py == null) return

    let target: Point = { x: px, y: py }
    const paused = actor.state === 'paused'
    if (!actor.positioned) {
      actor.positioned = true
      if (paused) {
        actor.restore = { ...target }
        target = parkOnEdge(target, viewportSize())
      }
      actor.pos = target
      actor.el.classList.add('on')
      applyPosition(actor)
      if (actor.state === 'idle') applyState(actor, 'moving', false)
      layoutTags()
      return
    }

    if (paused) {
      actor.restore = { ...target }
      target = parkOnEdge(target, viewportSize())
    }

    const rawDuration =
      typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : DEFAULT_DURATION
    const duration = clamp(rawDuration, MIN_DURATION, MAX_DURATION)
    startMotion(actor, target, duration)
    if (actor.state === 'idle') applyState(actor, 'moving', false)
  }

  function click(actorName: unknown, x: number, y: number): void {
    // 点击涟漪只由显式 click()（或 clicking 状态的首帧）产生；移动/动画结束不会
    // 自动变成“完成/成功”视觉。lastClickAt 用来避免两种入口重复出涟漪。
    const actor = ensureActor(actorName)
    if (!actor) return
    const px = finiteNumber(x)
    const py = finiteNumber(y)
    if (px == null || py == null) return
    const target: Point = { x: px, y: py }

    if (!actor.positioned) {
      actor.positioned = true
      actor.pos = target
      actor.el.classList.add('on')
      actor.motion = null
      applyPosition(actor)
    } else if (reducedMotion.value) {
      actor.pos = target
      actor.motion = null
      applyPosition(actor)
    } else {
      actor.motion = makeMotion(actor.pos, target, now(), 140)
      schedule()
    }
    actor.lastClickAt = now()
    spawnRipple(px, py, actor.color)
    layoutTags()
  }

  function remove(actorName: unknown): void {
    const id = normalizeActor(actorName)
    const actor = actors.get(id)
    if (!actor) return
    actor.el.remove()
    actors.delete(id)
    if (actors.size === 0 && rafId !== 0) {
      window.cancelAnimationFrame(rafId)
      rafId = 0
    }
  }

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    if (rafId !== 0) {
      window.cancelAnimationFrame(rafId)
      rafId = 0
    }
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    if (options.reducedMotion === undefined) {
      box?.removeEventListener('change', onMotionPreference)
    }
    actors.clear()
    window.removeEventListener('resize', onViewportChange)
    host.remove()
  }

  function onViewportChange(): void {
    layoutTags()
  }
  window.addEventListener('resize', onViewportChange)

  return {
    setCursor(actorName: string, state: CursorState): void {
      const actor = ensureActor(actorName)
      if (!actor || !isCursorState(state)) return
      applyState(actor, state, true)
    },
    moveTo,
    click,
    remove,
    destroy
  }
}
