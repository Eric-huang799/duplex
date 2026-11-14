/**
 * 画布的纯逻辑层：坐标换算、吸附、缩放、令牌解析、样式安全与 patch 摘要。
 *
 * 这里刻意**不碰 DOM**：
 *  - 单测在 node 环境（tsconfig.node）里直接跑；
 *  - 宿主/主进程将来要复用同一套换算时可以直接 import。
 *
 * 坐标系约定（全画布一致）：
 *  - **layout（设计帧）坐标**：页面元素未缩放时的布局坐标，原点在页面左上角。
 *    当前预览宽度（frameWidth）下的 layout 像素就是"设计帧"单位；
 *  - **client / screen 坐标**：浏览器视口坐标（getBoundingClientRect 的坐标系）；
 *  - 两者之间只差一个当前缩放比 scale 与页面原点 offset。
 * 发送给宿主的位置消息一律用 layout 坐标 + frameWidth，宿主再换算到它自己的
 * 设计帧（doc.frame.width）上去。
 */

import {
  anchorPoint,
  moveDelta,
  snapPoint,
  type AnchorName,
  type DesignNode,
  type DesignTokens,
  type PatchOp,
  type Point,
  type Rect,
  type SnapCandidate,
  type SnapResult,
  type StyleTokenRef
} from '../shared/design/model'

// ---------------------------------------------------------------- 常量

/** 九点锚点（不含 custom：custom 需要比例，宿主自己解释）。 */
export const NINE_ANCHORS: readonly AnchorName[] = [
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

/** 网格吸附步长（layout px）。 */
export const GRID_STEP = 8

/** 吸附阈值（屏幕 px；换算成 layout px 要除以 scale）。 */
export const SNAP_SCREEN_THRESHOLD = 8

/** `Z` 键循环的整体缩放档位。 */
export const ZOOM_STEPS: readonly number[] = [1, 0.5, 0.25]

export const MIN_VIEWPORT_WIDTH = 320
export const MAX_VIEWPORT_WIDTH = 1920

export const VIEWPORT_PADDING = 48

export interface Breakpoint {
  id: 'desktop' | 'tablet' | 'phone'
  label: string
  width: number
}

/** 工具栏的三个断点。1440 同时是 emptyDocument 的默认设计帧宽。 */
export const BREAKPOINTS: readonly Breakpoint[] = [
  { id: 'desktop', label: '桌面', width: 1440 },
  { id: 'tablet', label: '平板', width: 834 },
  { id: 'phone', label: '手机', width: 390 }
]

// ---------------------------------------------------------------- 基础换算

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function clampViewportWidth(width: number): number {
  return Math.round(clamp(width, MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH))
}

/** 让 `width` 宽的页面塞进 `availableWidth` 时能用的缩放比（不放大超过 1）。 */
export function fitScale(width: number, availableWidth: number, padding = VIEWPORT_PADDING): number {
  if (width <= 0) return 1
  const usable = Math.max(1, availableWidth - padding * 2)
  return clamp(Math.min(1, usable / width), 0.05, 1)
}

/** 适配缩放 × 用户缩放（`Z` 键）。 */
export function effectiveScale(
  width: number,
  availableWidth: number,
  zoom: number,
  padding = VIEWPORT_PADDING
): number {
  return clamp(fitScale(width, availableWidth, padding) * clamp(zoom, 0.1, 4), 0.02, 4)
}

export interface FitGeometry {
  width: number
  availableWidth: number
  zoom: number
  /** 只由"塞得下"决定的缩放 */
  fit: number
  /** 实际生效的缩放（fit × zoom） */
  scale: number
  /** 缩放后的页面宽度（用于滚动容器占位） */
  scaledWidth: number
}

export function fitGeometry(
  width: number,
  availableWidth: number,
  zoom: number,
  padding = VIEWPORT_PADDING
): FitGeometry {
  const fit = fitScale(width, availableWidth, padding)
  const scale = clamp(fit * zoom, 0.02, 4)
  return { width, availableWidth, zoom, fit, scale, scaledWidth: width * scale }
}

/** `Z` 键：1 → 0.5 → 0.25 → 1。未知值回到 1。 */
export function cycleZoom(zoom: number): number {
  const index = ZOOM_STEPS.findIndex((step) => Math.abs(step - zoom) < 0.001)
  if (index < 0) return ZOOM_STEPS[0]
  return ZOOM_STEPS[(index + 1) % ZOOM_STEPS.length]
}

/** 当前宽度恰好命中哪个断点（用于按钮高亮）。 */
export function activeBreakpoint(width: number): Breakpoint['id'] | null {
  const hit = BREAKPOINTS.find((breakpoint) => Math.abs(breakpoint.width - width) < 0.5)
  return hit ? hit.id : null
}

export function layoutToScreen(point: Point, pageOrigin: Point, scale: number): Point {
  return { x: pageOrigin.x + point.x * scale, y: pageOrigin.y + point.y * scale }
}

export function screenToLayout(point: Point, pageOrigin: Point, scale: number): Point {
  const safe = scale <= 0 ? 1 : scale
  return { x: (point.x - pageOrigin.x) / safe, y: (point.y - pageOrigin.y) / safe }
}

export function screenRectToLayout(rect: Rect, pageOrigin: Point, scale: number): Rect {
  const topLeft = screenToLayout({ x: rect.x, y: rect.y }, pageOrigin, scale)
  const safe = scale <= 0 ? 1 : scale
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: rect.width / safe,
    height: rect.height / safe
  }
}

export function layoutRectToScreen(rect: Rect, pageOrigin: Point, scale: number): Rect {
  return {
    x: pageOrigin.x + rect.x * scale,
    y: pageOrigin.y + rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale
  }
}

/** 吸附阈值：屏幕 8px 在 layout 里是 8/scale（缩得越小，容忍的 layout 距离越大）。 */
export function snapThresholdForScale(scale: number): number {
  const safe = scale <= 0 ? 1 : scale
  return Math.max(1, SNAP_SCREEN_THRESHOLD / safe)
}

// ---------------------------------------------------------------- 吸附

export interface RectTarget {
  id: string
  rect: Rect
}

/** 某个矩形（元素）的九个锚点候选。`from` 用元素 id，方便画参考线时标注。 */
export function anchorsOf(rect: Rect, id: string): SnapCandidate[] {
  return NINE_ANCHORS.map((anchor) => ({ point: anchorPoint(rect, anchor), from: `${id}:${anchor}` }))
}

export function anchorCandidatesOf(targets: readonly RectTarget[]): SnapCandidate[] {
  const out: SnapCandidate[] = []
  for (const target of targets) out.push(...anchorsOf(target.rect, target.id))
  return out
}

/**
 * 8px 网格候选：只生成目标点附近的 3×3 个格点（全画布铺开会是几万个点）。
 * 三个 x 值分别是 floor、floor+step、floor+2step，保证目标点两侧都被覆盖。
 */
export function gridCandidatesNear(desired: Point, step = GRID_STEP): SnapCandidate[] {
  const size = Math.max(1, step)
  const baseX = Math.floor(desired.x / size) * size
  const baseY = Math.floor(desired.y / size) * size
  const out: SnapCandidate[] = []
  for (let ix = 0; ix < 3; ix++) {
    for (let iy = 0; iy < 3; iy++) {
      out.push({ point: { x: baseX + ix * size, y: baseY + iy * size }, from: 'grid' })
    }
  }
  return out
}

/**
 * 容器边缘候选：把目标点投影到每个容器的四条边线上（水平边保持 x、垂直边保持 y），
 * 以及四个角。页面根 / 祖先容器由调用方传进来。
 */
export function containerEdgeCandidates(
  targets: readonly RectTarget[],
  desired: Point
): SnapCandidate[] {
  const out: SnapCandidate[] = []
  for (const target of targets) {
    const { x, y, width, height } = target.rect
    const edges: Array<{ point: Point; edge: string }> = [
      { point: { x, y: desired.y }, edge: 'left' },
      { point: { x: x + width, y: desired.y }, edge: 'right' },
      { point: { x: desired.x, y }, edge: 'top' },
      { point: { x: desired.x, y: y + height }, edge: 'bottom' },
      { point: { x, y }, edge: 'top-left' },
      { point: { x: x + width, y }, edge: 'top-right' },
      { point: { x, y: y + height }, edge: 'bottom-left' },
      { point: { x: x + width, y: y + height }, edge: 'bottom-right' }
    ]
    for (const item of edges) {
      out.push({ point: item.point, from: `${target.id}:${item.edge}` })
    }
  }
  return out
}

export type SnapTier = 'anchor' | 'edge' | 'grid'

export interface SnapTierInput {
  tier: SnapTier
  candidates: readonly SnapCandidate[]
}

export interface TierSnapResult extends SnapResult {
  tier: SnapTier | null
  /** 命中的候选来源（`id:anchor` / `id:left` / `grid`） */
  from: string | null
}

/**
 * 分档吸附：按 tiers 的**顺序**依次尝试 `snapPoint`，先命中者胜。
 * 这就是"吸附优先级"：元素锚点 > 容器边缘 > 网格。
 * 同档内仍然是距离最近者胜（沿用 model.snapPoint 的语义）。
 */
export function snapToTiers(
  desired: Point,
  tiers: readonly SnapTierInput[],
  threshold = SNAP_SCREEN_THRESHOLD
): TierSnapResult {
  for (const { tier, candidates } of tiers) {
    const result = snapPoint(desired, candidates as SnapCandidate[], threshold)
    if (result.snapped) {
      return { ...result, tier, from: result.snapped.from }
    }
  }
  return { point: desired, snapped: null, distance: Number.POSITIVE_INFINITY, tier: null, from: null }
}

/** 点落在矩形的哪个锚点最近（定位器用它把点击位置解释成锚点）。 */
export function nearestAnchor(rect: Rect, point: Point): AnchorName {
  let best: AnchorName = 'center'
  let bestDistance = Number.POSITIVE_INFINITY
  for (const anchor of NINE_ANCHORS) {
    const candidate = anchorPoint(rect, anchor)
    const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = anchor
    }
  }
  return best
}

/** 把 `anchor` 对齐到 `target` 所需的位移（迁移到一个新矩形）。 */
export function movedRect(rect: Rect, anchor: AnchorName, target: Point): Rect {
  const delta = moveDelta(rect, anchor, target)
  return { x: rect.x + delta.x, y: rect.y + delta.y, width: rect.width, height: rect.height }
}

/** 拖拽落点：矩形中心应当落到的 layout 坐标。 */
export function dragTarget(rect: Rect, clientCenter: Point): Point {
  return { x: clientCenter.x, y: clientCenter.y }
}

/** 祖先 id（root → parent，不含自身）。 */
export function ancestorIds(root: DesignNode, id: string): string[] {
  const trail: string[] = []
  const walk = (node: DesignNode, path: string[]): boolean => {
    if (node.id === id) {
      trail.push(...path)
      return true
    }
    for (const child of node.children ?? []) {
      if (walk(child, [...path, node.id])) return true
    }
    return false
  }
  walk(root, [])
  return trail
}

// ---------------------------------------------------------------- 测量 / 微调

export interface Measurement {
  a: Point
  b: Point
  dx: number
  dy: number
  /** 两点直线距离 */
  distance: number
  mid: Point
}

export function measureBetween(a: Point, b: Point): Measurement {
  return {
    a,
    b,
    dx: b.x - a.x,
    dy: b.y - a.y,
    distance: Math.hypot(b.x - a.x, b.y - a.y),
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }
}

/** 检视器上下键微调：direction=1 加、-1 减；shift 走大步。 */
export function nudgeNumber(
  value: number,
  direction: 1 | -1,
  step = 1,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY
): number {
  return clamp(value + direction * step, min, max)
}

// ---------------------------------------------------------------- 令牌与样式

export type TokenGroup = keyof DesignTokens
const TOKEN_GROUPS: readonly TokenGroup[] = ['color', 'space', 'text', 'radius']

function isTokenGroup(name: string): name is TokenGroup {
  return (TOKEN_GROUPS as readonly string[]).includes(name)
}

/**
 * 解析令牌。支持三种写法：
 *  - `color.brand.primary`（组 + 键）
 *  - `brand.primary`（省略组，按 color/space/text/radius 顺序查键）
 *  - `text.heading` / `space.4` / `radius.md`
 */
export function resolveToken(tokens: DesignTokens, token: string): string | null {
  const name = token.trim()
  if (!name) return null
  const dot = name.indexOf('.')
  if (dot > 0) {
    const group = name.slice(0, dot)
    const key = name.slice(dot + 1)
    if (isTokenGroup(group)) {
      const value = tokens[group][key]
      if (typeof value === 'string') return value
    }
  }
  for (const group of TOKEN_GROUPS) {
    const value = tokens[group][name]
    if (typeof value === 'string') return value
  }
  return null
}

/** 解析 `DesignNode.style` 的一项：token 优先，`value` 作为回退。 */
export function resolveStyleValue(tokens: DesignTokens, value: StyleTokenRef | string): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value.token === 'string') {
    const resolved = resolveToken(tokens, value.token)
    if (resolved !== null) return resolved
  }
  if (typeof value.value === 'string') {
    const trimmed = value.value.trim()
    return trimmed ? trimmed : null
  }
  return null
}

/**
 * 样式属性安全网：拒绝会触发加载 / 脚本 / 外部引用的写法。
 * 节点样式来自 agent 生成，不能让它顺手把画布变成网络的出口。
 */
const UNSAFE_PROPERTIES: ReadonlySet<string> = new Set([
  'behavior',
  '-moz-binding',
  'content',
  'background-image'
])

const UNSAFE_VALUE = /url\s*\(|expression\s*\(|javascript\s*:|@import|-moz-binding|behavior\s*:/i

export function isSafeStyleProperty(property: string): boolean {
  const name = property.trim().toLowerCase()
  if (!name) return false
  if (name.startsWith('on')) return false
  return !UNSAFE_PROPERTIES.has(name)
}

export function isSafeStyleValue(value: string): boolean {
  if (!value) return false
  return !UNSAFE_VALUE.test(value)
}

/** `flexDirection` / `flex-direction` / `--custom-prop` 统一成 CSS 属性名。 */
export function toCssPropertyName(key: string): string {
  const name = key.trim()
  if (!name) return ''
  if (name.startsWith('--')) return name
  if (name.includes('-')) return name.toLowerCase()
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

// ---------------------------------------------------------------- 元素标签安全网

/**
 * 允许出现在画布里的标签。**白名单**（不是黑名单）：
 * script / style / iframe / object / embed / link / meta / form / a / img 一律不在其中，
 * 避免生成节点自行加载资源或导航。
 */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'div',
  'span',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'main',
  'aside',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'figure',
  'figcaption',
  'blockquote',
  'strong',
  'em',
  'small',
  'hr',
  'dl',
  'dt',
  'dd',
  'pre',
  'code',
  'button',
  'input',
  'label'
])

const DEFAULT_TAG: Record<DesignNode['type'], string> = {
  page: 'div',
  box: 'div',
  stack: 'div',
  grid: 'div',
  text: 'p',
  heading: 'h2',
  button: 'button',
  input: 'input',
  image: 'div',
  spacer: 'div'
}

/** 节点 → 实际 DOM 标签。自定义 tag 必须过白名单。 */
export function elementTagFor(node: DesignNode): string {
  const custom = typeof node.tag === 'string' ? node.tag.trim().toLowerCase() : ''
  if (custom && ALLOWED_TAGS.has(custom)) return custom
  return DEFAULT_TAG[node.type] ?? 'div'
}

// ---------------------------------------------------------------- patch 摘要

export interface OpChanges {
  inserted: Set<string>
  replaced: Set<string>
  updated: Set<string>
  removed: Set<string>
  structural: boolean
  tokensChanged: boolean
  count: number
}

/** 从一批 op 里抽出"哪些节点变了"，供 DOM 层做最小重排与高亮。 */
export function summarizeOps(ops: readonly PatchOp[]): OpChanges {
  const changes: OpChanges = {
    inserted: new Set(),
    replaced: new Set(),
    updated: new Set(),
    removed: new Set(),
    structural: false,
    tokensChanged: false,
    count: ops.length
  }
  for (const op of ops) {
    switch (op.op) {
      case 'insert':
        changes.inserted.add(op.node.id)
        changes.structural = true
        break
      case 'replace':
        changes.replaced.add(op.node.id)
        changes.structural = true
        break
      case 'update':
        changes.updated.add(op.targetId)
        break
      case 'remove':
        changes.removed.add(op.targetId)
        changes.structural = true
        break
      case 'move':
        changes.structural = true
        break
      case 'token':
        changes.tokensChanged = true
        break
      default:
        break
    }
  }
  return changes
}

/** 需要打 `just-changed` 的节点（新增 / 替换 / 更新）。 */
export function flashTargets(changes: OpChanges): string[] {
  return [...new Set([...changes.inserted, ...changes.replaced, ...changes.updated])]
}

/** 需要做淡入+尺寸过渡的节点（新增 / 替换）。 */
export function entranceTargets(changes: OpChanges): string[] {
  return [...new Set([...changes.inserted, ...changes.replaced])]
}

// ---------------------------------------------------------------- 显示格式

export function formatPx(value: number): string {
  return `${Math.round(value * 100) / 100}px`
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

export function formatDelta(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded}`
}

/**
 * 帧内绝对定位的数值解析：`x` / `y` / `w` / `h` 接受 `"120"` 或 `"120px"`（帧坐标 px）。
 * 只认纯数字（可带负号/小数），`auto`、百分比、`calc()` 一律视为无效。
 */
export function parseFrameLength(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const match = /^(-?\d+(?:\.\d+)?)(px)?$/i.exec(trimmed)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}
