/**
 * 设计画布的文档模型（纯数据 + 纯函数，不依赖 Electron）。
 *
 * 这一层是所有功能的地基：
 *  - **定位**：每个节点有稳定 id（生成站点里写进 `data-did`），锚点/吸附都基于它；
 *  - **撤销**：patch 是唯一的修改入口，撤销就是"反向 patch"，不依赖 git；
 *  - **归属**：每个节点记录创建者与步号，约束记录发起者；
 *  - **多视口**：节点不含绝对像素，坐标只作为约束存在，渲染时按断点解析。
 */

export type NodeType =
  | 'page'
  | 'box'
  | 'stack'
  | 'grid'
  | 'text'
  | 'heading'
  | 'button'
  | 'input'
  | 'image'
  | 'spacer'

/** 九点锚点 + 自定义比例（0~1）。 */
export type AnchorName =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right'
  | 'custom'

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 生成该节点的来源，用于"这是谁做的"。 */
export interface Provenance {
  actor: string
  step: number
  at: number
}

export interface StyleTokenRef {
  /** 令牌名（如 color.brand、space.4、text.heading） */
  token?: string
  /** 直接值；与 token 同时存在时 token 优先，值仅作回退 */
  value?: string
}

export interface DesignNode {
  id: string
  type: NodeType
  /** 文案/占位内容 */
  text?: string
  /** 语义化标签覆盖（如 header/nav/main） */
  tag?: string
  /** 修饰样式：键为 CSS 属性名或令牌引用 */
  style?: Record<string, StyleTokenRef | string>
  /** 仅容器可用 */
  children?: DesignNode[]
  /** 创建来源 */
  meta?: {
    createdBy?: Provenance
    /** 被用户锁定后，agent 的 patch 不得触碰（含子树） */
    locked?: boolean
    /** 用户手动改过（UI 上标记"你改过"） */
    editedByUser?: boolean
  }
}

export interface DesignTokens {
  color: Record<string, string>
  space: Record<string, string>
  text: Record<string, string>
  radius: Record<string, string>
}

export type ConstraintKind = 'move' | 'lock' | 'text' | 'style' | 'reflow'

/**
 * 用户表达的意图。agent 必须"满足或显式冲突"，不能悄悄折中。
 */
export interface DesignConstraint {
  id: string
  kind: ConstraintKind
  targetId: string
  /** 设计帧内的目标位置（move） */
  target?: { anchor: AnchorName; point: Point; frameWidth: number }
  /** 文案/样式等直接值 */
  value?: string
  /** 创建者：用户介入 vs agent 自述 */
  createdBy: string
  at: number
  status: 'active' | 'satisfied' | 'conflict'
  note?: string
}

export interface DesignVariant {
  blockId: string
  options: DesignNode[]
  chosenIndex?: number
  label?: string
}

export interface DesignDocument {
  id: string
  name: string
  /** 设计帧：所有绝对坐标意图都在这个宽度下表达 */
  frame: { width: number; height: number }
  tokens: DesignTokens
  root: DesignNode
  constraints: DesignConstraint[]
  variants: DesignVariant[]
  /** 单调递增，用于 patch 幂等与 git 对应 */
  version: number
  updatedAt: number
}

// ---------------------------------------------------------------- patch ops

export type PatchOp =
  | { op: 'insert'; parentId: string; index?: number; node: DesignNode }
  | { op: 'replace'; targetId: string; node: DesignNode }
  | { op: 'remove'; targetId: string }
  | { op: 'update'; targetId: string; patch: Partial<Pick<DesignNode, 'text' | 'style' | 'tag' | 'meta'>> }
  | { op: 'move'; targetId: string; parentId: string; index?: number }
  | { op: 'token'; name: keyof DesignTokens; key: string; value: string }

export interface PatchActor {
  actor: string
  step: number
  at: number
}

export interface PatchResult {
  document: DesignDocument
  /** 实际生效的 op 数（被锁区拒绝的不计） */
  applied: number
  /** 被拒绝的 op 及原因（锁定/找不到节点/校验失败） */
  rejected: Array<{ index: number; reason: string }>
}

export interface PatchOptions {
  /** 用户直接编辑时可以跳过锁检查 */
  allowLocked?: boolean
}

const CONTAINER_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  'page',
  'box',
  'stack',
  'grid'
])

export function isContainer(node: DesignNode): boolean {
  return CONTAINER_TYPES.has(node.type)
}

/** 深拷贝一份（文档不可变，patch 返回新文档）。 */
export function cloneDocument(doc: DesignDocument): DesignDocument {
  return structuredClone(doc)
}

/** 深度优先找节点。 */
export function findNode(root: DesignNode, id: string): DesignNode | null {
  if (root.id === id) return root
  for (const child of root.children ?? []) {
    const hit = findNode(child, id)
    if (hit) return hit
  }
  return null
}

/** 找父节点与索引。 */
export function findParent(
  root: DesignNode,
  id: string
): { parent: DesignNode; index: number } | null {
  const children = root.children ?? []
  for (let i = 0; i < children.length; i++) {
    if (children[i].id === id) return { parent: root, index: i }
    const hit = findParent(children[i], id)
    if (hit) return hit
  }
  return null
}

/** 锁定检查：目标节点或任一祖先被锁，视为锁定。 */
export function isLocked(root: DesignNode, id: string): boolean {
  if (root.id === id) return root.meta?.locked === true
  for (const child of root.children ?? []) {
    const hit = child.id === id || findNode(child, id) !== null
    if (!hit) continue
    if (child.meta?.locked) return true
    return root.meta?.locked === true || isLocked(child, id)
  }
  return false
}

/** 收集所有节点 id（用于校验重复 id）。 */
export function collectIds(root: DesignNode, out: Set<string> = new Set()): Set<string> {
  out.add(root.id)
  for (const child of root.children ?? []) collectIds(child, out)
  return out
}

function validateInsert(doc: DesignDocument, parentId: string, node: DesignNode): string | null {
  const parent = findNode(doc.root, parentId)
  if (!parent) return `父节点不存在：${parentId}`
  if (!isContainer(parent)) return `父节点不是容器：${parentId}（${parent.type}）`
  if (collectIds(doc.root).has(node.id)) return `节点 id 重复：${node.id}`
  return null
}

/**
 * 应用一批 patch。返回**新文档**，原文档不变；单个 op 失败不影响其它 op。
 * 这是唯一的修改入口：撤销 = 应用反向 op，agent 改画布也必须走这里。
 */
export function applyPatch(
  doc: DesignDocument,
  ops: PatchOp[],
  actor: PatchActor,
  options: PatchOptions = {}
): PatchResult {
  const next = cloneDocument(doc)
  const rejected: Array<{ index: number; reason: string }> = []
  let applied = 0

  ops.forEach((op, index) => {
    try {
      if (op.op === 'token') {
        if (!(op.name in next.tokens)) throw new Error(`未知令牌组：${op.name}`)
        next.tokens[op.name][op.key] = op.value
        applied++
        return
      }

      if (op.op === 'insert') {
        const problem = validateInsert(next, op.parentId, op.node)
        if (problem) throw new Error(problem)
        if (!options.allowLocked && isLocked(next.root, op.parentId)) {
          throw new Error(`目标节点已锁定：${op.parentId}`)
        }
        const parent = findNode(next.root, op.parentId)!
        const children = parent.children ?? []
        const at = Math.max(0, Math.min(op.index ?? children.length, children.length))
        children.splice(at, 0, op.node)
        parent.children = children
        applied++
        return
      }

      if (op.op === 'replace') {
        const found = findParent(next.root, op.targetId)
        if (!found) {
          if (next.root.id === op.targetId) {
            next.root = op.node
            applied++
            return
          }
          throw new Error(`目标不存在：${op.targetId}`)
        }
        if (!options.allowLocked && isLocked(next.root, op.targetId)) {
          throw new Error(`目标节点已锁定：${op.targetId}`)
        }
        found.parent.children![found.index] = op.node
        applied++
        return
      }

      if (op.op === 'remove') {
        const found = findParent(next.root, op.targetId)
        if (!found) throw new Error(`目标不存在：${op.targetId}`)
        if (!options.allowLocked && isLocked(next.root, op.targetId)) {
          throw new Error(`目标节点已锁定：${op.targetId}`)
        }
        found.parent.children!.splice(found.index, 1)
        applied++
        return
      }

      if (op.op === 'move') {
        const found = findParent(next.root, op.targetId)
        if (!found) throw new Error(`目标不存在：${op.targetId}`)
        if (!options.allowLocked && isLocked(next.root, op.targetId)) {
          throw new Error(`目标节点已锁定：${op.targetId}`)
        }
        const destination = findNode(next.root, op.parentId)
        if (!destination) throw new Error(`目标父节点不存在：${op.parentId}`)
        if (!isContainer(destination)) throw new Error(`目标父节点不是容器：${op.parentId}`)
        const [node] = found.parent.children!.splice(found.index, 1)
        const children = destination.children ?? []
        const at = Math.max(0, Math.min(op.index ?? children.length, children.length))
        children.splice(at, 0, node)
        destination.children = children
        applied++
        return
      }

      // update
      const node = findNode(next.root, op.targetId)
      if (!node) throw new Error(`目标不存在：${op.targetId}`)
      if (!options.allowLocked && isLocked(next.root, op.targetId)) {
        throw new Error(`目标节点已锁定：${op.targetId}`)
      }
      if (op.patch.text !== undefined) node.text = op.patch.text
      if (op.patch.tag !== undefined) node.tag = op.patch.tag
      if (op.patch.style !== undefined) node.style = { ...(node.style ?? {}), ...op.patch.style }
      if (op.patch.meta !== undefined) node.meta = { ...(node.meta ?? {}), ...op.patch.meta }
      node.meta = { ...(node.meta ?? {}), createdBy: node.meta?.createdBy ?? actor }
      applied++
    } catch (error) {
      rejected.push({ index, reason: (error as Error).message })
    }
  })

  next.version = doc.version + (applied > 0 ? 1 : 0)
  next.updatedAt = actor.at
  // 归属：新插入节点如果没有来源，补上本次 actor
  const stamp = (node: DesignNode): void => {
    if (!node.meta?.createdBy) node.meta = { ...(node.meta ?? {}), createdBy: actor }
    for (const child of node.children ?? []) stamp(child)
  }
  stamp(next.root)
  return { document: next, applied, rejected }
}

// ---------------------------------------------------------------- anchors

export function anchorPoint(rect: Rect, anchor: AnchorName): Point {
  const { x, y, width, height } = rect
  switch (anchor) {
    case 'top-left':
      return { x, y }
    case 'top':
      return { x: x + width / 2, y }
    case 'top-right':
      return { x: x + width, y }
    case 'left':
      return { x, y: y + height / 2 }
    case 'right':
      return { x: x + width, y: y + height / 2 }
    case 'bottom-left':
      return { x, y: y + height }
    case 'bottom':
      return { x: x + width / 2, y: y + height }
    case 'bottom-right':
      return { x: x + width, y: y + height }
    case 'custom':
    case 'center':
    default:
      return { x: x + width / 2, y: y + height / 2 }
  }
}

export interface SnapCandidate {
  /** 吸附点坐标 */
  point: Point
  /** 来源说明：其它元素 id、网格、容器边缘 */
  from: string
}

export interface SnapResult {
  point: Point
  snapped: SnapCandidate | null
  distance: number
}

/** 就近吸附：阈值外保持原点。用于定位器把"目标点"吸到元素/网格/边缘上。 */
export function snapPoint(
  desired: Point,
  candidates: SnapCandidate[],
  threshold = 8
): SnapResult {
  let best: SnapCandidate | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.point.x - desired.x, candidate.point.y - desired.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  if (best && bestDistance <= threshold) {
    return { point: best.point, snapped: best, distance: bestDistance }
  }
  return { point: desired, snapped: null, distance: bestDistance }
}

/** 生成网格吸附点（每 step 像素）。 */
export function gridCandidates(size: number, step = 8): SnapCandidate[] {
  const out: SnapCandidate[] = []
  for (let i = 0; i <= Math.floor(size / step); i++) {
    const v = i * step
    out.push({ point: { x: v, y: 0 }, from: 'grid-x' })
    out.push({ point: { x: 0, y: v }, from: 'grid-y' })
  }
  return out
}

/** 把"锚点对齐到目标点"换算成位移量。 */
export function moveDelta(rect: Rect, anchor: AnchorName, target: Point): Point {
  const current = anchorPoint(rect, anchor)
  return { x: target.x - current.x, y: target.y - current.y }
}

// ---------------------------------------------------------------- constraints

export function addConstraint(
  doc: DesignDocument,
  constraint: Omit<DesignConstraint, 'id' | 'at' | 'status'>
): DesignDocument {
  const next = cloneDocument(doc)
  const id = `c${next.version + 1}-${next.constraints.length + 1}`
  next.constraints.push({ ...constraint, id, at: Date.now(), status: 'active' })
  next.version += 1
  return next
}

export function resolveConstraint(
  doc: DesignDocument,
  id: string,
  status: 'satisfied' | 'conflict',
  note?: string
): DesignDocument {
  const next = cloneDocument(doc)
  next.constraints = next.constraints.map((c) =>
    c.id === id ? { ...c, status, ...(note ? { note } : {}) } : c
  )
  next.version += 1
  return next
}

// ---------------------------------------------------------------- document

export function emptyDocument(name = '未命名设计', id = 'design-1'): DesignDocument {
  return {
    id,
    name,
    frame: { width: 1440, height: 900 },
    tokens: {
      color: {
        'brand.primary': '#2f6fed',
        'brand.on': '#ffffff',
        'surface.base': '#ffffff',
        'surface.alt': '#f5f7fb',
        'text.primary': '#111827',
        'text.muted': '#6b7280',
        'line.soft': '#e5e7eb'
      },
      space: { '1': '4px', '2': '8px', '3': '16px', '4': '24px', '5': '32px', '6': '48px', '7': '64px' },
      text: {
        heading: '600 clamp(32px, 4vw, 56px)/1.1 var(--font-sans)',
        title: '600 20px/1.3 var(--font-sans)',
        body: '400 16px/1.6 var(--font-sans)',
        caption: '400 13px/1.4 var(--font-sans)'
      },
      radius: { sm: '6px', md: '12px', lg: '20px' }
    },
    root: { id: 'root', type: 'page', children: [] },
    constraints: [],
    variants: [],
    version: 0,
    updatedAt: Date.now()
  }
}

/** 计算文档的稳定指纹，用于 git 提交去重与 diff 对齐。 */
export function documentFingerprint(doc: DesignDocument): string {
  const json = JSON.stringify({
    root: doc.root,
    tokens: doc.tokens,
    constraints: doc.constraints,
    variants: doc.variants
  })
  let hash = 0x811c9dc5
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
