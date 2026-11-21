/**
 * 设计与协作可视化层的**纯函数**（不碰 DOM）。
 *
 * 三个 DOM 模块（cursor-layer / loupe / locator）共用这里的调色板、缓动、
 * 标签避让、吸附候选和读数格式化；`tests/overlay-*.test.ts` 只导入这一层，
 * 因此可以在 node 环境（无 DOM）里直接单测。
 *
 * 这里不修改 `src/shared/design/model.ts`，只复用它的锚点与吸附定义。
 */
import { anchorPoint, snapPoint } from '../shared/design/model'
import type { AnchorName, Point, Rect, SnapCandidate, SnapResult } from '../shared/design/model'

export type { AnchorName, Point, Rect, SnapCandidate, SnapResult } from '../shared/design/model'

// --------------------------------------------------------------- actors

/** 12 色稳定调色板：按 actor 字符串哈希取色，同一 actor 永远同一色。 */
export const ACTOR_PALETTE: readonly string[] = [
  '#4da3ff',
  '#f2994a',
  '#56cc99',
  '#b579f6',
  '#ef6f8f',
  '#e8b84b',
  '#35c3d1',
  '#8d9cff',
  '#7ac943',
  '#ff8a65',
  '#c084fc',
  '#2ec4b6'
]

/** FNV-1a 32 位。只为稳定，不用于安全场景。 */
export function hashActor(actor: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < actor.length; i++) {
    hash ^= actor.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 每个 actor 的稳定颜色（12 色循环）。 */
export function actorColor(actor: string): string {
  const index = hashActor(actor) % ACTOR_PALETTE.length
  return ACTOR_PALETTE[index] ?? ACTOR_PALETTE[0]!
}

/**
 * 光标短标签：最多 `max` 个字符（含省略号），按 Unicode 码点截断，
 * 避免把代理对（emoji）劈成乱码。
 */
export function actorLabel(actor: string, max = 12): string {
  const raw = (actor ?? '').trim()
  const chars = Array.from(raw.length > 0 ? raw : 'anon')
  const limit = Math.max(1, Math.floor(max))
  if (chars.length <= limit) return chars.join('')
  return chars.slice(0, limit - 1).join('') + '…'
}

// --------------------------------------------------------------- cursor states

export const CURSOR_STATES = [
  'thinking',
  'moving',
  'clicking',
  'typing',
  'blocked',
  'paused',
  'failed'
] as const

export type CursorState = (typeof CURSOR_STATES)[number]

export function isCursorState(value: unknown): value is CursorState {
  return typeof value === 'string' && (CURSOR_STATES as readonly string[]).includes(value)
}

// --------------------------------------------------------------- motion

export function clamp(value: number, min: number, max: number): number {
  if (min > max) return min
  return Math.min(Math.max(value, min), max)
}

/** 标准 easeInOutCubic，入参自动夹到 [0,1]。 */
export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

export interface Motion {
  from: Point
  to: Point
  startedAt: number
  durationMs: number
}

export function makeMotion(
  from: Point,
  to: Point,
  startedAt: number,
  durationMs: number
): Motion {
  return { from: { ...from }, to: { ...to }, startedAt, durationMs: Math.max(0, durationMs) }
}

/** 某时刻的缓动位置；未开始/已结束都返回端点，绝不越界。 */
export function motionPoint(motion: Motion, now: number): Point {
  if (motion.durationMs <= 0) return { ...motion.to }
  const t = (now - motion.startedAt) / motion.durationMs
  if (!(t > 0)) return { ...motion.from }
  if (t >= 1) return { ...motion.to }
  const eased = easeInOutCubic(t)
  return {
    x: motion.from.x + (motion.to.x - motion.from.x) * eased,
    y: motion.from.y + (motion.to.y - motion.from.y) * eased
  }
}

export function isMotionDone(motion: Motion, now: number): boolean {
  return motion.durationMs <= 0 || now - motion.startedAt >= motion.durationMs
}

/** paused 时把光标收到最近的页边（只收水平方向，y 只做夹取）。 */
export function parkOnEdge(
  position: Point,
  viewport: { width: number; height: number },
  inset = 10
): Point {
  const maxY = Math.max(inset, viewport.height - inset)
  return {
    x: position.x <= viewport.width / 2 ? inset : Math.max(inset, viewport.width - inset),
    y: clamp(position.y, inset, maxY)
  }
}

// --------------------------------------------------------------- labels

export interface LabelBox {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface LabelPlacement {
  id: string
  dx: number
  dy: number
}

export interface LabelLayoutOptions {
  viewport: { width: number; height: number }
  gap?: number
  margin?: number
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  gap: number
): boolean {
  return (
    a.x < b.x + b.width + gap &&
    b.x < a.x + a.width + gap &&
    a.y < b.y + b.height + gap &&
    b.y < a.y + a.height + gap
  )
}

/**
 * 多光标标签避让：按传入顺序放置，重叠就上下错开（必要时翻到指针左侧）。
 * 返回相对基础位置（标签默认在指针右下）的位移，供调用方设置 transform。
 */
export function layoutLabels(
  boxes: readonly LabelBox[],
  options: LabelLayoutOptions
): LabelPlacement[] {
  const gap = options.gap ?? 4
  const margin = options.margin ?? 6
  const viewportWidth = options.viewport.width
  const viewportHeight = options.viewport.height
  const placed: Array<{ x: number; y: number; width: number; height: number }> = []
  const result: LabelPlacement[] = []

  for (const box of boxes) {
    const width = Math.max(1, box.width)
    const height = Math.max(1, box.height)
    const step = height + gap
    const flippedDx = box.x + width > viewportWidth - margin ? -(width + 28) : 0
    const dxCandidates = flippedDx !== 0 ? [flippedDx, 0] : [0]
    const candidates: Array<{ dx: number; dy: number }> = []
    for (let i = 0; i < 6; i++) {
      const offset = i * step
      for (const dx of dxCandidates) candidates.push({ dx, dy: offset })
      if (i > 0) for (const dx of dxCandidates) candidates.push({ dx, dy: -offset })
    }

    let chosen: LabelPlacement | null = null
    for (const candidate of candidates) {
      const rect = {
        x: box.x + candidate.dx,
        y: clamp(box.y + candidate.dy, margin, Math.max(margin, viewportHeight - height - margin)),
        width,
        height
      }
      if (rect.x + width > viewportWidth - margin || rect.x < margin) continue
      if (placed.some((other) => overlaps(other, rect, gap))) continue
      placed.push(rect)
      chosen = { id: box.id, dx: candidate.dx, dy: rect.y - box.y }
      break
    }

    if (!chosen) {
      // 实在放不下：仍然保证不与已放置的标签完全重叠（错开一个标签高度）。
      const rect = {
        x: clamp(box.x, margin, Math.max(margin, viewportWidth - width - margin)),
        y: clamp(
          box.y + (placed.length % 6) * step,
          margin,
          Math.max(margin, viewportHeight - height - margin)
        ),
        width,
        height
      }
      placed.push(rect)
      chosen = { id: box.id, dx: rect.x - box.x, dy: rect.y - box.y }
    }

    result.push(chosen)
  }

  return result
}

// --------------------------------------------------------------- snap

export interface Viewport {
  width: number
  height: number
}

/** 九点锚点（顺序 = 视觉上的 3×3，从左上到右下）。 */
export const ANCHOR_NAMES: readonly AnchorName[] = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right'
]

export function roundToGrid(value: number, step = 8): number {
  if (!(step > 0)) return value
  return Math.round(value / step) * step
}

/** 8px 网格候选：把点吸到最近的网格交点。 */
export function gridSnapCandidate(point: Point, step = 8): SnapCandidate {
  return {
    point: { x: roundToGrid(point.x, step), y: roundToGrid(point.y, step) },
    from: 'grid'
  }
}

/** 视口四边候选：只有贴近某条边（阈值内）才产生，保持另一轴不动。 */
export function edgeSnapCandidates(
  point: Point,
  viewport: Viewport,
  threshold = 8
): SnapCandidate[] {
  const out: SnapCandidate[] = []
  if (point.x <= threshold) out.push({ point: { x: 0, y: point.y }, from: 'viewport-left' })
  if (viewport.width - point.x <= threshold) {
    out.push({ point: { x: viewport.width, y: point.y }, from: 'viewport-right' })
  }
  if (point.y <= threshold) out.push({ point: { x: point.x, y: 0 }, from: 'viewport-top' })
  if (viewport.height - point.y <= threshold) {
    out.push({ point: { x: point.x, y: viewport.height }, from: 'viewport-bottom' })
  }
  return out
}

/** 一个元素的 9 个锚点候选，`from` 编码成 `<id>@<anchor>` 便于反解。 */
export function anchorCandidates(rect: Rect, id: string): SnapCandidate[] {
  return ANCHOR_NAMES.map((anchor) => ({
    point: anchorPoint(rect, anchor),
    from: `${id}@${anchor}`
  }))
}

/** 从候选来源反解锚点名；不是锚点候选就返回 null。 */
export function anchorFromCandidate(from: string): AnchorName | null {
  const at = from.lastIndexOf('@')
  if (at < 0) return null
  const candidate = from.slice(at + 1)
  return (ANCHOR_NAMES as readonly string[]).includes(candidate)
    ? (candidate as AnchorName)
    : null
}

/** 离目标点最近的锚点（定位器在自由点/吸附失败时回退用）。 */
export function nearestAnchor(
  rect: Rect,
  point: Point
): { anchor: AnchorName; point: Point; distance: number } {
  let best: { anchor: AnchorName; point: Point; distance: number } | null = null
  for (const anchor of ANCHOR_NAMES) {
    const candidate = anchorPoint(rect, anchor)
    const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y)
    if (!best || distance < best.distance) best = { anchor, point: candidate, distance }
  }
  return best ?? { anchor: 'center', point: anchorPoint(rect, 'center'), distance: 0 }
}

export interface SnapRect {
  id: string
  rect: Rect
}

export interface SnapOptions {
  viewport: Viewport
  threshold?: number
  step?: number
  /** 默认 true；关掉后只吸元素锚点与视口边缘。 */
  grid?: boolean
}

export interface SnapDecision {
  point: Point
  snapped: SnapCandidate | null
  distance: number
  anchor: AnchorName | null
  /** 吸附成功后应画参考线的位置；未吸附为 null。 */
  guides: { x: number | null; y: number | null }
}

/**
 * 分层吸附：先试元素锚点 + 视口边缘（阈值 8px），都没有才退到 8px 网格。
 *
 * 为什么要分层：最近的网格点距离永远 ≤ 5.66px，如果和锚点混在一起比距离，
 * 元素锚点几乎永远抢不过网格。分层后「元素优先、网格兜底」才符合设计意图。
 */
export function resolveSnap(
  desired: Point,
  rects: readonly SnapRect[],
  options: SnapOptions
): SnapDecision {
  const threshold = options.threshold ?? 8
  const candidates: SnapCandidate[] = []
  for (const { id, rect } of rects) candidates.push(...anchorCandidates(rect, id))
  candidates.push(...edgeSnapCandidates(desired, options.viewport, threshold))

  let decision: SnapResult = snapPoint(desired, candidates, threshold)
  if (!decision.snapped && options.grid !== false) {
    decision = snapPoint(desired, [gridSnapCandidate(desired, options.step ?? 8)], threshold)
  }

  if (!decision.snapped) {
    return {
      point: { ...desired },
      snapped: null,
      distance: 0,
      anchor: null,
      guides: { x: null, y: null }
    }
  }

  const point = { ...decision.point }
  return {
    point,
    snapped: decision.snapped,
    distance: decision.distance,
    anchor: anchorFromCandidate(decision.snapped.from),
    guides: { x: point.x, y: point.y }
  }
}

// --------------------------------------------------------------- measure

export interface Measurement {
  dx: number
  dy: number
  distance: number
  horizontal: number
  vertical: number
}

export function measureBetween(from: Point, to: Point): Measurement {
  const dx = to.x - from.x
  const dy = to.y - from.y
  return {
    dx,
    dy,
    distance: Math.hypot(dx, dy),
    horizontal: Math.abs(dx),
    vertical: Math.abs(dy)
  }
}

export function formatMeasurePrimary(measurement: Measurement): string {
  return `${Math.round(measurement.distance)}px`
}

/** 水平/垂直分量（带符号，便于看出方向）。 */
export function formatMeasureDelta(measurement: Measurement): string {
  return `水平 ${Math.round(Math.abs(measurement.dx))}px · 垂直 ${Math.round(
    Math.abs(measurement.dy)
  )}px`
}

// --------------------------------------------------------------- readouts

export function formatPointReadout(point: Point): string {
  return `${Math.round(point.x)}, ${Math.round(point.y)}`
}

export function formatSize(width: number, height: number): string {
  return `${Math.round(width)}×${Math.round(height)}`
}

export interface ElementIdentity {
  did?: string | null
  id?: string | null
  tag: string
}

/** 元素的可定位 id：优先 data-did（设计节点稳定 id），其次 #id，最后标签名。 */
export function elementTargetId(identity: ElementIdentity): string {
  const did = (identity.did ?? '').trim()
  if (did) return did
  const id = (identity.id ?? '').trim()
  if (id) return `#${id}`
  const tag = (identity.tag ?? '').trim().toLowerCase()
  return tag || 'element'
}

/**
 * 把 `rgb()/rgba()` 归一成 `#rrggbb`（不透明）或 `rgba(...)`（半透明）；
 * 其它值原样返回（超长截断），保证读数栏不撑破。
 */
export function normalizeColor(value: string): string {
  const raw = (value ?? '').trim()
  if (!raw) return 'transparent'
  if (raw === 'transparent') return 'transparent'
  const match = /^rgba?\(([^)]+)\)$/i.exec(raw)
  if (match) {
    const parts = (match[1] ?? '').split(/[,/\s]+/).filter(Boolean)
    const channels = parts.slice(0, 3).map((part) =>
      Math.round(part.endsWith('%') ? (parseFloat(part) * 255) / 100 : parseFloat(part))
    )
    if (channels.length === 3 && channels.every((channel) => Number.isFinite(channel))) {
      const alphaRaw = parts[3]
      const alpha =
        alphaRaw === undefined
          ? 1
          : alphaRaw.endsWith('%')
            ? parseFloat(alphaRaw) / 100
            : parseFloat(alphaRaw)
      const hex = `#${channels
        .map((channel) => clamp(channel, 0, 255).toString(16).padStart(2, '0'))
        .join('')}`
      if (!Number.isFinite(alpha) || alpha >= 1) return hex
      if (alpha <= 0) return 'transparent'
      return `rgba(${channels.join(', ')}, ${Math.round(clamp(alpha, 0, 1) * 100) / 100})`
    }
  }
  return raw.length > 40 ? `${raw.slice(0, 39)}…` : raw
}
