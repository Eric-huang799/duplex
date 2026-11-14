/**
 * 设计服务入参校验（纯函数，不依赖 Electron / fs）。
 *
 * 渲染层可以把 `design:apply` 的参数直接传成任意对象（包括原型污染形状），
 * 所以主进程必须：
 *  1. 只认识白名单字段（多余的键一律拒绝，不做"猜测"）；
 *  2. 逐层重建新对象（不把来路不明的引用带进文档）；
 *  3. 给长度 / 深度 / 节点数设上限，避免一次 IPC 把主进程拖死。
 *
 * 校验失败一律 `{ ok: false, error }`，绝不 throw 到 IPC 边界之外；
 * 内部实现用 throw 是为了让路径信息（`ops[3].node.children[0]`）自然带上。
 */
import type {
  AnchorName,
  ConstraintKind,
  DesignConstraint,
  DesignNode,
  DesignTokens,
  NodeType,
  PatchOp,
  StyleTokenRef
} from '../../shared/design/model'

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string }

export type ConstraintInput = Omit<DesignConstraint, 'id' | 'at' | 'status'>

export interface ApplyPayload {
  actor: string
  ops: PatchOp[]
  allowLocked: boolean
}

export interface ResolveConstraintInput {
  id: string
  status: 'satisfied' | 'conflict'
  note?: string
}

export interface SetVariantsPayload {
  blockId: string
  options: DesignNode[]
}

export interface ChooseVariantPayload {
  blockId: string
  index: number
}

const LIMITS = {
  maxString: 20_000,
  maxId: 256,
  maxText: 200_000,
  maxStyleKeys: 200,
  maxNodes: 10_000,
  maxNodeDepth: 64,
  maxChildren: 2_000,
  maxOps: 2_000,
  maxVariants: 32,
  maxIndex: 1_000_000,
  maxSummary: 500,
  maxHistoryLimit: 200
} as const

const NODE_TYPES: ReadonlySet<string> = new Set<NodeType>([
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
])

const CONTAINER_TYPES: ReadonlySet<string> = new Set<NodeType>(['page', 'box', 'stack', 'grid'])

const TOKEN_GROUPS: ReadonlySet<string> = new Set<keyof DesignTokens>([
  'color',
  'space',
  'text',
  'radius'
])

const CONSTRAINT_KINDS: ReadonlySet<string> = new Set<ConstraintKind>([
  'move',
  'lock',
  'text',
  'style',
  'reflow'
])

const ANCHORS: ReadonlySet<string> = new Set<AnchorName>([
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
  'custom'
])

// 项目 id 会成为目录名：限定字符集 + 拒绝 Windows 保留名（CON/NUL 等会创建失败或落到设备）。
const PROJECT_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

function guard<T>(fn: () => T): Validation<T> {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

function fail(path: string, reason: string): never {
  throw new Error(`${path}: ${reason}`)
}

function assertKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(path, `不允许的字段 ${key}`)
  }
}

function str(
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean; max?: number } = {}
): string {
  if (typeof value !== 'string') fail(path, '必须是字符串')
  const max = options.max ?? LIMITS.maxString
  if (value.length > max) fail(path, `超过最大长度 ${max}`)
  if (options.allowEmpty !== true && value.trim().length === 0) fail(path, '不能为空')
  return value
}

function int(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(path, '必须是整数')
  if (value < min || value > max) fail(path, `必须在 ${min}~${max} 之间`)
  return value
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, '必须是有限数字')
  return value
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, '必须是布尔值')
  return value
}

// ---------------------------------------------------------------- project / actor / 小标量

function sanitizeProjectId(value: unknown): string {
  const id = str(value, 'projectId', { max: 64 })
  if (!PROJECT_ID_RE.test(id) || WINDOWS_RESERVED.test(id) || id.includes('..')) {
    fail('projectId', '只能包含字母/数字/._-，且必须以字母或数字开头结尾（不能是 Windows 保留名）')
  }
  return id
}

export function isValidProjectId(value: unknown): value is string {
  return typeof value === 'string' && validateProjectId(value).ok
}

export function validateProjectId(value: unknown): Validation<string> {
  return guard(() => sanitizeProjectId(value))
}

export function validateActorId(value: unknown): Validation<string> {
  return guard(() => str(value, 'actor', { max: 128 }))
}

function sanitizeActor(value: unknown): string {
  return str(value, 'actor', { max: 128 })
}

export function isBlockId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= LIMITS.maxId
}

export function validateBlockId(value: unknown): Validation<string> {
  return guard(() => str(value, 'blockId', { max: LIMITS.maxId }))
}

export function validateSummary(value: unknown): Validation<string> {
  return guard(() => str(value, 'summary', { max: LIMITS.maxSummary }))
}

export function validateLimit(value: unknown): Validation<number | undefined> {
  return guard(() => (value === undefined ? undefined : int(value, 'limit', 1, LIMITS.maxHistoryLimit)))
}

// ---------------------------------------------------------------- 节点

interface NodeBudget {
  count: number
}

function sanitizeStyle(value: unknown, path: string): Record<string, StyleTokenRef | string> {
  if (!isPlainObject(value)) fail(path, '必须是对象')
  const keys = Object.keys(value)
  if (keys.length > LIMITS.maxStyleKeys) fail(path, `样式键超过上限 ${LIMITS.maxStyleKeys}`)
  const style: Record<string, StyleTokenRef | string> = {}
  for (const key of keys) {
    if (key.length === 0 || key.length > 128) fail(path, `样式键名不合法：${key}`)
    const entry = value[key]
    const entryPath = `${path}.${key}`
    if (typeof entry === 'string') {
      if (entry.length > LIMITS.maxString) fail(entryPath, `超过最大长度 ${LIMITS.maxString}`)
      style[key] = entry
      continue
    }
    if (!isPlainObject(entry)) fail(entryPath, '必须是字符串或 { token, value }')
    assertKeys(entry, new Set(['token', 'value']), entryPath)
    const ref: StyleTokenRef = {}
    if (entry['token'] !== undefined) ref.token = str(entry['token'], `${entryPath}.token`, { max: 128 })
    if (entry['value'] !== undefined) {
      ref.value = str(entry['value'], `${entryPath}.value`, { allowEmpty: true, max: LIMITS.maxString })
    }
    if (ref.token === undefined && ref.value === undefined) fail(entryPath, 'token 与 value 至少要有一个')
    style[key] = ref
  }
  return style
}

function sanitizeMeta(value: unknown, path: string): NonNullable<DesignNode['meta']> {
  if (!isPlainObject(value)) fail(path, '必须是对象')
  assertKeys(value, new Set(['createdBy', 'locked', 'editedByUser']), path)
  const meta: NonNullable<DesignNode['meta']> = {}
  if (value['createdBy'] !== undefined) {
    const createdBy = value['createdBy']
    const createdPath = `${path}.createdBy`
    if (!isPlainObject(createdBy)) fail(createdPath, '必须是对象')
    assertKeys(createdBy, new Set(['actor', 'step', 'at']), createdPath)
    meta.createdBy = {
      actor: str(createdBy['actor'], `${createdPath}.actor`, { max: 128 }),
      step: int(createdBy['step'], `${createdPath}.step`, 0, Number.MAX_SAFE_INTEGER),
      at: finite(createdBy['at'], `${createdPath}.at`)
    }
  }
  if (value['locked'] !== undefined) meta.locked = bool(value['locked'], `${path}.locked`)
  if (value['editedByUser'] !== undefined) {
    meta.editedByUser = bool(value['editedByUser'], `${path}.editedByUser`)
  }
  return meta
}

function sanitizeNode(
  value: unknown,
  path: string,
  budget: NodeBudget,
  depth: number
): DesignNode {
  if (depth > LIMITS.maxNodeDepth) fail(path, `节点嵌套超过 ${LIMITS.maxNodeDepth} 层`)
  budget.count += 1
  if (budget.count > LIMITS.maxNodes) fail(path, `节点总数超过上限 ${LIMITS.maxNodes}`)
  if (!isPlainObject(value)) fail(path, '必须是对象')
  assertKeys(value, new Set(['id', 'type', 'text', 'tag', 'style', 'children', 'meta']), path)

  const id = str(value['id'], `${path}.id`, { max: LIMITS.maxId })
  const rawType = value['type']
  if (typeof rawType !== 'string' || !NODE_TYPES.has(rawType)) {
    fail(`${path}.type`, `未知的节点类型 ${String(rawType)}`)
  }
  const type = rawType as NodeType
  const node: DesignNode = { id, type }

  if (value['text'] !== undefined) {
    node.text = str(value['text'], `${path}.text`, { allowEmpty: true, max: LIMITS.maxText })
  }
  if (value['tag'] !== undefined) {
    node.tag = str(value['tag'], `${path}.tag`, { allowEmpty: true, max: 128 })
  }
  if (value['style'] !== undefined) node.style = sanitizeStyle(value['style'], `${path}.style`)
  if (value['meta'] !== undefined) node.meta = sanitizeMeta(value['meta'], `${path}.meta`)

  if (value['children'] !== undefined) {
    const children = value['children']
    if (!CONTAINER_TYPES.has(type)) {
      fail(`${path}.children`, `非容器节点 ${type} 不能有 children`)
    }
    if (!Array.isArray(children)) fail(`${path}.children`, '必须是数组')
    if (children.length > LIMITS.maxChildren) {
      fail(`${path}.children`, `子节点超过上限 ${LIMITS.maxChildren}`)
    }
    node.children = children.map((child, index) =>
      sanitizeNode(child, `${path}.children[${index}]`, budget, depth + 1)
    )
  }
  return node
}

export function validateDesignNode(value: unknown): Validation<DesignNode> {
  return guard(() => sanitizeNode(value, 'node', { count: 0 }, 0))
}

function sanitizeNodeArray(value: unknown, path: string, max: number): DesignNode[] {
  if (!Array.isArray(value)) fail(path, '必须是数组')
  if (value.length > max) fail(path, `最多 ${max} 个节点`)
  const budget: NodeBudget = { count: 0 }
  return value.map((node, index) => sanitizeNode(node, `${path}[${index}]`, budget, 0))
}

function sanitizeNodePatch(
  value: unknown,
  path: string
): Partial<Pick<DesignNode, 'text' | 'style' | 'tag' | 'meta'>> {
  if (!isPlainObject(value)) fail(path, '必须是对象')
  assertKeys(value, new Set(['text', 'tag', 'style', 'meta']), path)
  const patch: Partial<Pick<DesignNode, 'text' | 'style' | 'tag' | 'meta'>> = {}
  if (value['text'] !== undefined) {
    patch.text = str(value['text'], `${path}.text`, { allowEmpty: true, max: LIMITS.maxText })
  }
  if (value['tag'] !== undefined) {
    patch.tag = str(value['tag'], `${path}.tag`, { allowEmpty: true, max: 128 })
  }
  if (value['style'] !== undefined) patch.style = sanitizeStyle(value['style'], `${path}.style`)
  if (value['meta'] !== undefined) patch.meta = sanitizeMeta(value['meta'], `${path}.meta`)
  return patch
}

// ---------------------------------------------------------------- patch ops

function sanitizeOp(value: unknown, path: string): PatchOp {
  if (!isPlainObject(value)) fail(path, '必须是对象')
  const op = value['op']
  switch (op) {
    case 'insert': {
      assertKeys(value, new Set(['op', 'parentId', 'index', 'node']), path)
      const parentId = str(value['parentId'], `${path}.parentId`, { max: LIMITS.maxId })
      const index =
        value['index'] === undefined
          ? undefined
          : int(value['index'], `${path}.index`, 0, LIMITS.maxIndex)
      const node = sanitizeNode(value['node'], `${path}.node`, { count: 0 }, 0)
      return { op: 'insert', parentId, ...(index !== undefined ? { index } : {}), node }
    }
    case 'replace': {
      assertKeys(value, new Set(['op', 'targetId', 'node']), path)
      const targetId = str(value['targetId'], `${path}.targetId`, { max: LIMITS.maxId })
      const node = sanitizeNode(value['node'], `${path}.node`, { count: 0 }, 0)
      return { op: 'replace', targetId, node }
    }
    case 'remove': {
      assertKeys(value, new Set(['op', 'targetId']), path)
      return { op: 'remove', targetId: str(value['targetId'], `${path}.targetId`, { max: LIMITS.maxId }) }
    }
    case 'update': {
      assertKeys(value, new Set(['op', 'targetId', 'patch']), path)
      return {
        op: 'update',
        targetId: str(value['targetId'], `${path}.targetId`, { max: LIMITS.maxId }),
        patch: sanitizeNodePatch(value['patch'], `${path}.patch`)
      }
    }
    case 'move': {
      assertKeys(value, new Set(['op', 'targetId', 'parentId', 'index']), path)
      const index =
        value['index'] === undefined
          ? undefined
          : int(value['index'], `${path}.index`, 0, LIMITS.maxIndex)
      return {
        op: 'move',
        targetId: str(value['targetId'], `${path}.targetId`, { max: LIMITS.maxId }),
        parentId: str(value['parentId'], `${path}.parentId`, { max: LIMITS.maxId }),
        ...(index !== undefined ? { index } : {})
      }
    }
    case 'token': {
      assertKeys(value, new Set(['op', 'name', 'key', 'value']), path)
      const name = value['name']
      if (typeof name !== 'string' || !TOKEN_GROUPS.has(name)) {
        fail(`${path}.name`, '必须是 color / space / text / radius')
      }
      return {
        op: 'token',
        name: name as keyof DesignTokens,
        key: str(value['key'], `${path}.key`, { max: LIMITS.maxId }),
        value: str(value['value'], `${path}.value`, { allowEmpty: true, max: LIMITS.maxString })
      }
    }
    default:
      return fail(`${path}.op`, `未知的 op 类型 ${String(op)}`)
  }
}

function sanitizePatchOps(value: unknown): PatchOp[] {
  if (!Array.isArray(value)) fail('ops', '必须是数组')
  if (value.length > LIMITS.maxOps) fail('ops', `最多 ${LIMITS.maxOps} 个 op`)
  return value.map((op, index) => sanitizeOp(op, `ops[${index}]`))
}

export function validatePatchOps(value: unknown): Validation<PatchOp[]> {
  return guard(() => sanitizePatchOps(value))
}

export function validateApplyPayload(value: unknown): Validation<ApplyPayload> {
  return guard(() => {
    if (!isPlainObject(value)) fail('apply', '参数必须是对象')
    assertKeys(value, new Set(['actor', 'ops', 'allowLocked']), 'apply')
    let allowLocked = false
    if (value['allowLocked'] !== undefined) allowLocked = bool(value['allowLocked'], 'apply.allowLocked')
    return { actor: sanitizeActor(value['actor']), ops: sanitizePatchOps(value['ops']), allowLocked }
  })
}

// ---------------------------------------------------------------- 约束 / 变体

function sanitizeConstraintTarget(value: unknown, path: string): NonNullable<DesignConstraint['target']> {
  if (!isPlainObject(value)) fail(path, '必须是对象')
  assertKeys(value, new Set(['anchor', 'point', 'frameWidth']), path)
  const anchor = value['anchor']
  if (typeof anchor !== 'string' || !ANCHORS.has(anchor)) fail(`${path}.anchor`, '未知的锚点')
  const point = value['point']
  if (!isPlainObject(point)) fail(`${path}.point`, '必须是 { x, y }')
  assertKeys(point, new Set(['x', 'y']), `${path}.point`)
  return {
    anchor: anchor as AnchorName,
    point: { x: finite(point['x'], `${path}.point.x`), y: finite(point['y'], `${path}.point.y`) },
    frameWidth: (() => {
      const width = finite(value['frameWidth'], `${path}.frameWidth`)
      if (width <= 0) fail(`${path}.frameWidth`, '必须大于 0')
      return width
    })()
  }
}

export function validateConstraintInput(value: unknown): Validation<ConstraintInput> {
  return guard(() => {
    if (!isPlainObject(value)) fail('constraint', '参数必须是对象')
    assertKeys(value, new Set(['kind', 'targetId', 'target', 'value', 'createdBy']), 'constraint')
    const kind = value['kind']
    if (typeof kind !== 'string' || !CONSTRAINT_KINDS.has(kind)) fail('constraint.kind', '未知的约束类型')
    const targetId = str(value['targetId'], 'constraint.targetId', { max: LIMITS.maxId })
    const createdBy = str(value['createdBy'], 'constraint.createdBy', { max: 128 })
    const input: ConstraintInput = { kind: kind as ConstraintKind, targetId, createdBy }
    if (value['value'] !== undefined) {
      input.value = str(value['value'], 'constraint.value', { allowEmpty: true, max: LIMITS.maxString })
    }
    if (value['target'] !== undefined) {
      input.target = sanitizeConstraintTarget(value['target'], 'constraint.target')
    }
    if (input.kind === 'move' && !input.target) fail('constraint.target', 'move 约束必须带 target')
    return input
  })
}

export function validateResolveConstraint(value: unknown): Validation<ResolveConstraintInput> {
  return guard(() => {
    if (!isPlainObject(value)) fail('constraint', '参数必须是对象')
    assertKeys(value, new Set(['action', 'id', 'status', 'note']), 'constraint')
    const id = str(value['id'], 'constraint.id', { max: LIMITS.maxId })
    const status = value['status']
    if (status !== 'satisfied' && status !== 'conflict') {
      fail('constraint.status', '必须是 satisfied 或 conflict')
    }
    const note =
      value['note'] === undefined
        ? undefined
        : str(value['note'], 'constraint.note', { allowEmpty: true, max: 2_000 })
    return { id, status, ...(note && note.trim().length > 0 ? { note } : {}) }
  })
}

export function validateSetVariantsPayload(value: unknown): Validation<SetVariantsPayload> {
  return guard(() => {
    if (!isPlainObject(value)) fail('variants', '参数必须是对象')
    assertKeys(value, new Set(['blockId', 'options']), 'variants')
    const blockId = str(value['blockId'], 'variants.blockId', { max: LIMITS.maxId })
    const options = sanitizeNodeArray(value['options'], 'variants.options', LIMITS.maxVariants)
    if (options.length === 0) fail('variants.options', '至少需要一个变体')
    return { blockId, options }
  })
}

export function validateChooseVariantPayload(value: unknown): Validation<ChooseVariantPayload> {
  return guard(() => {
    if (!isPlainObject(value)) fail('variant', '参数必须是对象')
    assertKeys(value, new Set(['blockId', 'index']), 'variant')
    return {
      blockId: str(value['blockId'], 'variant.blockId', { max: LIMITS.maxId }),
      index: int(value['index'], 'variant.index', 0, LIMITS.maxIndex)
    }
  })
}

// ---------------------------------------------------------------- commit / history / export

export function validateCommitPayload(value: unknown): Validation<string> {
  return guard(() => {
    if (!isPlainObject(value)) fail('commit', '参数必须是对象')
    assertKeys(value, new Set(['summary']), 'commit')
    return str(value['summary'], 'commit.summary', { max: LIMITS.maxSummary })
  })
}

export function validateHistoryPayload(
  value: unknown
): Validation<{ limit?: number }> {
  return guard(() => {
    if (value === undefined || value === null) return {}
    if (!isPlainObject(value)) fail('history', '参数必须是对象')
    assertKeys(value, new Set(['limit']), 'history')
    return value['limit'] === undefined
      ? {}
      : { limit: int(value['limit'], 'history.limit', 1, LIMITS.maxHistoryLimit) }
  })
}
