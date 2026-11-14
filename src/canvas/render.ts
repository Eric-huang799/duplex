/**
 * 文档 → DOM 渲染，以及 patch 的增量应用。
 *
 * 设计要点：
 *  - 每个节点一个 DOM 元素，带 `data-did` / `data-type`，方便定位、检视与拖拽；
 *  - 容器结构：`节点元素 > [caption] > .canvas-node__children`（`display: contents`，
 *    不破坏父级的 flex/grid 布局），子节点只和这个 host 对账；
 *  - apply 走"按 id 对账"：复用元素、只改变化的属性、跨父级 move 是搬移而不是重建；
 *  - 新增/替换：≤180ms 淡入 + 尺寸过渡；所有变动节点挂 2s `just-changed`；删除直接移除；
 *  - 文本一律 textContent，标签走白名单，样式值过安全网。
 */

import {
  collectIds,
  isContainer,
  type DesignDocument,
  type DesignNode,
  type NodeType,
  type PatchOp
} from '../shared/design/model'
import {
  elementTagFor,
  entranceTargets,
  flashTargets,
  isSafeStyleProperty,
  isSafeStyleValue,
  parseFrameLength,
  resolveStyleValue,
  resolveToken,
  summarizeOps,
  toCssPropertyName
} from './geometry'
import { el, setText } from './dom'

const CHILDREN_CLASS = 'canvas-node__children'
const CAPTION_CLASS = 'canvas-node__caption'
const MEDIA_CLASS = 'canvas-node__media'
const ENTER_MS = 180
const HIGHLIGHT_MS = 2000

/** 帧内绝对定位保留键：不能当 CSS 属性写。 */
const PLACEMENT_KEYS: ReadonlySet<string> = new Set(['x', 'y', 'w', 'h'])

const NODE_TYPES: readonly NodeType[] = [
  'page',
  'box',
  'stack',
  'grid',
  'text',
  'heading',
  'button',
  'input',
  'image',
  'spacer'
]

// ---------------------------------------------------------------- 类型

export interface ApplyReport {
  added: string[]
  replaced: string[]
  updated: string[]
  removed: string[]
  structural: boolean
  tokensChanged: boolean
  full: boolean
}

export interface CanvasRender {
  readonly doc: DesignDocument
  readonly page: HTMLElement
  readonly elements: ReadonlyMap<string, HTMLElement>
  get(id: string): HTMLElement | null
  list(): HTMLElement[]
  apply(next: DesignDocument, ops?: readonly PatchOp[]): ApplyReport
  destroy(): void
}

interface RenderContext {
  doc: DesignDocument
  mount: HTMLElement
  elements: Map<string, HTMLElement>
  timers: Map<string, number>
  report: ApplyReport
  liveIds: Set<string>
}

const renders = new WeakMap<HTMLElement, CanvasRender>()

function emptyReport(full = false): ApplyReport {
  return {
    added: [],
    replaced: [],
    updated: [],
    removed: [],
    structural: false,
    tokensChanged: false,
    full
  }
}

// ---------------------------------------------------------------- 样式

const warnedStyles = new Set<string>()
const warnedPlacements = new Set<string>()

function warnUnsafeStyle(property: string, value: string): void {
  const key = `${property}:${value}`
  if (warnedStyles.has(key)) return
  warnedStyles.add(key)
  console.warn(`[canvas] 已忽略不安全的样式：${property} = ${value}`)
}

function warnPlacement(key: string, value: string): void {
  const id = `${key}:${value}`
  if (warnedPlacements.has(id)) return
  warnedPlacements.add(id)
  console.warn(`[canvas] 帧内定位值无效（需要 px 数字）：${key} = ${value}`)
}

function tokenOf(doc: DesignDocument, name: string): string | null {
  return resolveToken(doc.tokens, name)
}

/**
 * 每个节点的默认样式（全部走令牌）。节点的 `style` 会在默认值之后覆盖。
 * 容器的布局形状在这里落定：stack → flex 竖排、grid → grid、box/page → 块。
 */
function defaultDeclarations(doc: DesignDocument, type: NodeType): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const put = (property: string, value: string | null): void => {
    if (value !== null && value !== '') out.push([property, value])
  }
  const space = (key: string): string | null => tokenOf(doc, `space.${key}`)
  const color = (key: string): string | null => tokenOf(doc, `color.${key}`)
  const text = (key: string): string | null => tokenOf(doc, `text.${key}`)
  const radius = (key: string): string | null => tokenOf(doc, `radius.${key}`)

  switch (type) {
    case 'page':
      out.push(['display', 'flex'], ['flex-direction', 'column'], ['position', 'relative'])
      put('font', text('body'))
      put('color', color('text.primary'))
      put('background-color', color('surface.base'))
      put('min-height', `${doc.frame.height}px`)
      break
    case 'stack':
      out.push(['display', 'flex'], ['flex-direction', 'column'], ['min-width', '0'])
      put('gap', space('3'))
      break
    case 'grid':
      out.push(
        ['display', 'grid'],
        ['grid-template-columns', 'repeat(auto-fit, minmax(220px, 1fr))'],
        ['min-width', '0']
      )
      put('gap', space('3'))
      break
    case 'box':
      out.push(['display', 'block'], ['min-width', '0'])
      break
    case 'text':
      put('font', text('body'))
      put('color', color('text.primary'))
      out.push(['margin', '0'], ['white-space', 'pre-wrap'])
      break
    case 'heading':
      put('font', text('heading'))
      put('color', color('text.primary'))
      out.push(['margin', '0'])
      break
    case 'button':
      put('font', text('body'))
      put('color', color('brand.on'))
      put('background-color', color('brand.primary'))
      out.push(
        ['border', '0'],
        ['display', 'inline-flex'],
        ['align-items', 'center'],
        ['justify-content', 'center'],
        ['align-self', 'flex-start'],
        ['cursor', 'default']
      )
      put('border-radius', radius('md'))
      put('padding', [space('2'), space('4')].filter(Boolean).join(' ') || null)
      break
    case 'input':
      put('font', text('body'))
      put('color', color('text.primary'))
      put('background-color', color('surface.base'))
      put('border', color('line.soft') ? `1px solid ${color('line.soft')}` : null)
      put('border-radius', radius('sm'))
      put('padding', [space('2'), space('3')].filter(Boolean).join(' ') || null)
      out.push(['display', 'block'], ['width', '100%'], ['cursor', 'default'])
      break
    case 'image':
      put('background-color', color('surface.alt'))
      put('color', color('text.muted'))
      put('font', text('caption'))
      put('border-radius', radius('md'))
      out.push(['display', 'flex'], ['align-items', 'center'], ['justify-content', 'center'])
      out.push(['min-height', '160px'], ['overflow', 'hidden'])
      break
    case 'spacer':
      put('height', space('5'))
      out.push(['min-height', space('1') ?? '4px'], ['display', 'block'])
      break
    default:
      out.push(['display', 'block'])
      break
  }
  return out
}

/**
 * 记录每个元素上一次写过的属性 → 值。
 * 不读 `element.style` 回值（浏览器会把 #fff 归一化成 rgb(...)，比对永远不等），
 * 而是和"上次我们写入的内容"比，做到真正的最小 DOM 写入。
 */
const appliedStyles = new WeakMap<HTMLElement, Map<string, string>>()

/** 把节点样式写进元素：只应用变化了的属性，避免每次 patch 重排整棵子树。 */
function applyNodeStyles(
  element: HTMLElement,
  node: DesignNode,
  doc: DesignDocument,
  isRoot = false
): void {
  const desired = new Map<string, string>()
  const add = (property: string, value: string): void => {
    const cssProperty = toCssPropertyName(property)
    if (!cssProperty) return
    if (!isSafeStyleProperty(cssProperty) || !isSafeStyleValue(value)) {
      warnUnsafeStyle(cssProperty, value)
      return
    }
    // 画布根节点的宽度与 transform 属于"视口预览"的控制项，不让文档覆盖。
    if (isRoot && (cssProperty === 'width' || cssProperty === 'transform')) return
    desired.set(cssProperty, value)
  }

  for (const [property, value] of defaultDeclarations(doc, node.type)) add(property, value)

  /**
   * 帧内绝对定位约定：`style.x` / `style.y` 是**设计帧坐标**（相对画布帧根），
   * 一旦出现就把节点从父级 flex/grid 流里摘出来；`style.w` / `style.h` 给宽高。
   * 这是"用户把元素挪到指定坐标"落地的方式（宿主下发 style:{x,y} 的 patch）。
   */
  if (!isRoot && node.style) {
    const readPlacement = (key: 'x' | 'y' | 'w' | 'h'): number | null => {
      const raw = node.style?.[key]
      if (raw === undefined) return null
      const resolved = resolveStyleValue(doc.tokens, raw)
      if (resolved === null) return null
      const parsed = parseFrameLength(resolved)
      if (parsed === null) {
        warnPlacement(key, resolved)
        return null
      }
      return parsed
    }
    const placementX = readPlacement('x')
    const placementY = readPlacement('y')
    const placementW = readPlacement('w')
    const placementH = readPlacement('h')
    if (placementX !== null || placementY !== null) {
      add('position', 'absolute')
      // 页面根是 position:relative（见 page 默认样式），所以坐标就是帧坐标。
      // 但预览宽度可能不是帧宽（手机 390 / 平板 834），坐标必须等比缩放，
      // 否则在 1440 帧里移动到 x=719 的元素，到手机预览会跑到画布外面。
      // 这是"响应式绝对定位"的默认行为；真正的断点规则仍由 agent 用 grid/flex 表达。
      if (placementX !== null) add('left', `calc(${placementX}px * var(--frame-scale, 1))`)
      if (placementY !== null) add('top', `calc(${placementY}px * var(--frame-scale, 1))`)
    }
    if (placementW !== null) add('width', `calc(${placementW}px * var(--frame-scale, 1))`)
    if (placementH !== null) add('height', `calc(${placementH}px * var(--frame-scale, 1))`)
  }

  for (const [property, raw] of Object.entries(node.style ?? {})) {
    if (PLACEMENT_KEYS.has(property)) continue
    const value = resolveStyleValue(doc.tokens, raw)
    if (value !== null) add(property, value)
  }

  const previous = appliedStyles.get(element) ?? new Map<string, string>()
  // 移除文档里已经不存在的内联属性
  for (const cssProperty of previous.keys()) {
    if (!desired.has(cssProperty)) element.style.removeProperty(cssProperty)
  }
  for (const [cssProperty, value] of desired) {
    if (previous.get(cssProperty) !== value) element.style.setProperty(cssProperty, value)
  }
  appliedStyles.set(element, desired)
}

function reapplyAllStyles(ctx: RenderContext): void {
  const walk = (node: DesignNode): void => {
    const isRoot = node.id === ctx.doc.root.id
    const element = isRoot ? ctx.mount : ctx.elements.get(node.id)
    if (element) applyNodeStyles(element, node, ctx.doc, isRoot)
    for (const child of node.children ?? []) walk(child)
  }
  walk(ctx.doc.root)
}

// ---------------------------------------------------------------- 元素构建

function applyTypeClass(element: HTMLElement, type: NodeType): void {
  element.classList.add('canvas-node')
  for (const candidate of NODE_TYPES) {
    element.classList.toggle(`canvas-node--${candidate}`, candidate === type)
  }
}

function setNodeTabBehavior(element: HTMLElement): void {
  element.draggable = false
  const tag = element.tagName.toLowerCase()
  if (tag === 'button') {
    element.setAttribute('type', 'button')
    ;(element as HTMLButtonElement).tabIndex = -1
  }
  if (tag === 'input') {
    const input = element as HTMLInputElement
    input.type = 'text'
    input.readOnly = true
    input.tabIndex = -1
    input.setAttribute('autocomplete', 'off')
    input.setAttribute('spellcheck', 'false')
  }
}

function createNodeElement(node: DesignNode): HTMLElement {
  const element = document.createElement(elementTagFor(node))
  applyTypeClass(element, node.type)
  element.setAttribute('data-node', '')
  element.dataset.did = node.id
  element.dataset.type = node.type
  setNodeTabBehavior(element)
  return element
}

function ensureChildrenHost(element: HTMLElement): HTMLElement {
  const existing = element.querySelector<HTMLElement>(`:scope > .${CHILDREN_CLASS}`)
  if (existing) return existing
  const host = el('div', { className: CHILDREN_CLASS, attrs: { 'data-children': '' } })
  element.append(host)
  return host
}

function ensureCaption(element: HTMLElement, text: string | undefined): void {
  const caption = element.querySelector<HTMLElement>(`:scope > .${CAPTION_CLASS}`)
  if (!text) {
    caption?.remove()
    return
  }
  if (caption) {
    setText(caption, text)
    return
  }
  const created = el('span', { className: CAPTION_CLASS })
  setText(created, text)
  element.prepend(created)
}

function setMediaLabel(element: HTMLElement, text: string | undefined): void {
  let label = element.querySelector<HTMLElement>(`:scope > .${MEDIA_CLASS}`)
  if (!label) {
    label = el('span', { className: MEDIA_CLASS })
    element.append(label)
  }
  setText(label, text && text.trim() ? text : '图片')
}

// ---------------------------------------------------------------- 对账

function markEntrance(element: HTMLElement): void {
  element.classList.remove('is-entering')
  // 强制一次样式计算，保证连续两次 patch 都能重新播放动画
  void element.offsetWidth
  element.classList.add('is-entering')
  window.setTimeout(() => element.classList.remove('is-entering'), ENTER_MS + 20)
}

function markPatchChange(ctx: RenderContext, element: HTMLElement, id: string, entrance: boolean): void {
  if (entrance) markEntrance(element)
  const previous = ctx.timers.get(id)
  if (previous !== undefined) window.clearTimeout(previous)
  element.classList.remove('just-changed')
  void element.offsetWidth
  element.classList.add('just-changed')
  const timer = window.setTimeout(() => {
    element.classList.remove('just-changed')
    ctx.timers.delete(id)
  }, HIGHLIGHT_MS)
  ctx.timers.set(id, timer)
}

function detachSubtree(ctx: RenderContext, element: HTMLElement): void {
  const ids: string[] = []
  if (element.dataset.did) ids.push(element.dataset.did)
  for (const descendant of element.querySelectorAll<HTMLElement>('[data-did]')) {
    if (descendant.dataset.did) ids.push(descendant.dataset.did)
  }
  for (const id of ids) {
    const timer = ctx.timers.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      ctx.timers.delete(id)
    }
    if (ctx.elements.get(id) !== ctx.mount) ctx.elements.delete(id)
  }
  element.remove()
}

function syncNode(element: HTMLElement, node: DesignNode, ctx: RenderContext): void {
  element.dataset.did = node.id
  element.dataset.type = node.type
  element.dataset.locked = node.meta?.locked === true ? 'true' : 'false'
  element.dataset.edited = node.meta?.editedByUser === true ? 'true' : 'false'
  applyTypeClass(element, node.type)
  applyNodeStyles(element, node, ctx.doc)

  if (isContainer(node)) {
    ensureCaption(element, node.text)
    const host = ensureChildrenHost(element)
    reconcileChildren(host, node.children ?? [], ctx)
    return
  }

  // 非容器：清掉容器遗留物
  element.querySelector<HTMLElement>(`:scope > .${CAPTION_CLASS}`)?.remove()
  const strayHost = element.querySelector<HTMLElement>(`:scope > .${CHILDREN_CLASS}`)
  if (strayHost) {
    for (const child of strayHost.querySelectorAll<HTMLElement>('[data-did]')) {
      if (child.dataset.did) ctx.elements.delete(child.dataset.did)
    }
    strayHost.remove()
  }

  if (element instanceof HTMLInputElement) {
    const value = node.text ?? ''
    if (element.value !== value) element.value = value
    return
  }
  if (node.type === 'image') {
    setMediaLabel(element, node.text)
    return
  }
  setText(element, node.type === 'spacer' ? '' : node.text ?? '')
}

function reconcileChildren(
  host: HTMLElement,
  children: readonly DesignNode[],
  ctx: RenderContext
): void {
  const keep = new Set<string>()
  let reference: Element | null = host.firstElementChild

  for (const child of children) {
    keep.add(child.id)
    let childElement = ctx.elements.get(child.id) ?? null

    // 类型或标签变了就必须换元素（div 变 section、p 变 h2）
    if (
      childElement &&
      (childElement.tagName.toLowerCase() !== elementTagFor(child) ||
        childElement.dataset.type !== child.type)
    ) {
      detachSubtree(ctx, childElement)
      childElement = null
    }

    if (!childElement) {
      childElement = createNodeElement(child)
      ctx.elements.set(child.id, childElement)
      ctx.report.added.push(child.id)
    }

    if (childElement === reference) {
      reference = reference.nextElementSibling
    } else {
      // 跨父级的 move 也会走到这里：insertBefore 是"搬移"，不会触发重建
      host.insertBefore(childElement, reference)
    }

    syncNode(childElement, child, ctx)
  }

  for (const extra of Array.from(host.children)) {
    const domElement = extra as HTMLElement
    const id = domElement.dataset.did
    if (!id) continue
    if (keep.has(id) || ctx.liveIds.has(id)) continue
    detachSubtree(ctx, domElement)
    ctx.report.removed.push(id)
  }
}

function syncRoot(ctx: RenderContext): void {
  const root = ctx.doc.root
  const mount = ctx.mount
  const previousId = mount.dataset.did
  mount.classList.add('canvas-page')
  applyTypeClass(mount, root.type)
  mount.dataset.type = root.type
  mount.dataset.locked = root.meta?.locked === true ? 'true' : 'false'
  mount.dataset.edited = root.meta?.editedByUser === true ? 'true' : 'false'
  if (previousId && previousId !== root.id) ctx.elements.delete(previousId)
  mount.dataset.did = root.id
  ctx.elements.set(root.id, mount)
  applyNodeStyles(mount, root, ctx.doc, true)
  const host = ensureChildrenHost(mount)
  reconcileChildren(host, root.children ?? [], ctx)
}

// ---------------------------------------------------------------- 对外 API

export function renderDocument(doc: DesignDocument, mount: HTMLElement): CanvasRender {
  const timers = new Map<string, number>()
  const ctx: RenderContext = {
    doc,
    mount,
    elements: new Map(),
    timers,
    report: emptyReport(true),
    liveIds: collectIds(doc.root)
  }

  mount.replaceChildren()
  syncRoot(ctx)

  for (const [, element] of ctx.elements) {
    if (element === mount) continue
    markEntrance(element)
  }

  const handle: CanvasRender = {
    get doc(): DesignDocument {
      return ctx.doc
    },
    page: mount,
    get elements(): ReadonlyMap<string, HTMLElement> {
      return ctx.elements
    },
    get(id: string): HTMLElement | null {
      return ctx.elements.get(id) ?? null
    },
    list(): HTMLElement[] {
      return [...ctx.elements.values()]
    },
    apply(next: DesignDocument, ops: readonly PatchOp[] = []): ApplyReport {
      if (next.id !== ctx.doc.id) {
        throw new Error(`apply() 只处理同一个文档（${ctx.doc.id}）的 patch；换文档请重新 renderDocument`)
      }
      const changes = summarizeOps(ops)
      ctx.doc = next
      ctx.report = emptyReport()
      ctx.liveIds = collectIds(next.root)
      syncRoot(ctx)

      if (changes.tokensChanged) reapplyAllStyles(ctx)

      ctx.report.replaced = [...changes.replaced]
      ctx.report.updated = [...changes.updated]
      ctx.report.structural = changes.structural
      ctx.report.tokensChanged = changes.tokensChanged

      const entrance = new Set([...entranceTargets(changes), ...ctx.report.added])
      const flash = new Set([...flashTargets(changes), ...ctx.report.added])
      for (const id of flash) {
        const element = ctx.elements.get(id)
        if (!element) continue
        markPatchChange(ctx, element, id, entrance.has(id))
      }
      return ctx.report
    },
    destroy(): void {
      for (const timer of ctx.timers.values()) window.clearTimeout(timer)
      ctx.timers.clear()
      ctx.elements.clear()
      renders.delete(mount)
      mount.replaceChildren()
    }
  }

  renders.set(mount, handle)
  return handle
}

/** 按名字直接应用一批 op（内部会复用已渲染的句柄；文档变了就整页重渲）。 */
export function applyOpsToDom(
  doc: DesignDocument,
  ops: readonly PatchOp[],
  mount: HTMLElement
): ApplyReport {
  const handle = renders.get(mount)
  if (!handle || handle.doc.id !== doc.id) {
    renderDocument(doc, mount)
    return { ...emptyReport(true), added: [] }
  }
  return handle.apply(doc, ops)
}

export function getCanvasRender(mount: HTMLElement): CanvasRender | null {
  return renders.get(mount) ?? null
}

/** 变体对比用的单节点渲染（不进入画布的元素表，不参与交互）。 */
export function renderNodeInto(node: DesignNode, doc: DesignDocument, host: HTMLElement): HTMLElement {
  const ctx: RenderContext = {
    doc,
    mount: host,
    elements: new Map(),
    timers: new Map(),
    report: emptyReport(true),
    liveIds: collectIds(doc.root)
  }
  const element = createNodeElement(node)
  host.append(element)
  syncNode(element, node, ctx)
  return element
}
