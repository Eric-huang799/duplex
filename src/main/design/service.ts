/**
 * DesignService：设计文档的主进程侧服务。
 *
 * 职责：
 *  - 打开项目（工作区在 `<cobrowseDir>/designs/<projectId>/`，测试可注入 root）；
 *  - 所有修改走 `applyPatch`，撤销/重做用**反向 patch**（不用 git）；
 *  - 内存文档 + dirty 标记：applyOps 不落盘（避免每帧 IO），
 *    commitRound / 切换项目 / close 时才写盘；
 *  - 一轮提交 = 落盘 + git commit + rounds.log 一行摘要；
 *  - 导出 = 最近一轮 HEAD 的 git archive zip。
 *
 * 并发说明：整个服务假定在 Electron 主进程事件循环里串行调用（JS 单线程，同步 API），
 * 不做锁；不要把多个 applyOps 的异步结果乱序扔进来——以最后一次落盘的文档为准。
 */
import {
  addConstraint as addConstraintToDocument,
  applyPatch,
  documentFingerprint,
  findNode,
  findParent,
  resolveConstraint as resolveConstraintInDocument,
  type DesignConstraint,
  type DesignDocument,
  type DesignNode,
  type PatchActor,
  type PatchOp,
  type PatchOptions,
  type StyleTokenRef
} from '../../shared/design/model'
import {
  appendRoundLog,
  designsRoot,
  loadDocument,
  projectDir,
  saveDocument
} from './store'
import {
  commitRound as commitRoundInGit,
  ensureRepo,
  exportZip as exportZipInGit,
  history as historyInGit,
  type ExportResult,
  type GitHistoryEntry
} from './git'

export interface DesignStateSnapshot {
  projectId: string | null
  version: number
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  undoDepth: number
  redoDepth: number
  updatedAt: number | null
}

export type DesignServiceEvent =
  | { type: 'document'; projectId: string; document: DesignDocument }
  | { type: 'state'; state: DesignStateSnapshot }
  | { type: 'rejected'; actor: string; rejected: Array<{ index: number; reason: string }> }

export type DesignEventSink = (event: DesignServiceEvent) => void

export interface DesignServiceDeps {
  /** 注入测试用工作区；默认 `<cobrowseDir>/designs`。 */
  root?: string
  /** 注入时钟（rounds.log / actor.at 用）。 */
  now?: () => number
  /** 事件出口（IPC 层把它转发给窗口）。 */
  emit?: DesignEventSink
}

export interface ApplyOpsOutcome {
  applied: number
  rejected: Array<{ index: number; reason: string }>
  doc: DesignDocument
}

export interface CommitOutcome {
  ok: boolean
  sha?: string
  skipped?: boolean
  error?: string
}

export interface ExportOutcome {
  ok: boolean
  path?: string
  error?: string
}

export type { GitHistoryEntry, ExportResult }

/** 一次成功的 applyOps 对应一条撤销记录：正向 op 用于 redo，反向 op 用于 undo。 */
interface UndoEntry {
  forward: PatchOp[]
  inverse: PatchOp[]
  actor: string
}

function cloneOps(ops: PatchOp[]): PatchOp[] {
  return structuredClone(ops)
}

function normalizeSummary(summary: string): string {
  const line = String(summary ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return line || '未命名轮次'
}

/**
 * 单个 op 的反向 op（基于该 op 生效**之前**的文档状态）。
 *
 * 规则：
 *  - insert  → remove（按 id）
 *  - remove  → insert（原父节点 + 原索引 + 节点快照）
 *  - replace → replace（旧节点快照）
 *  - update  → update（只回填旧值）；若某个被改的键原先并不存在（无法用 patch 表达"删除"），
 *              退化为 replace 整节点快照，保证撤销精确
 *  - move    → move（原父节点 + 原索引）
 *  - token   → token（旧值）
 *
 * 返回 null 表示文档里找不到目标（正常流程不会发生，因为对应 op 会被 applyPatch 拒绝）。
 */
function inverseOfOp(doc: DesignDocument, op: PatchOp): PatchOp | null {
  switch (op.op) {
    case 'insert':
      return { op: 'remove', targetId: op.node.id }

    case 'remove': {
      const node = findNode(doc.root, op.targetId)
      const found = findParent(doc.root, op.targetId)
      if (!node || !found) return null
      return {
        op: 'insert',
        parentId: found.parent.id,
        index: found.index,
        node: structuredClone(node)
      }
    }

    case 'replace': {
      const node = doc.root.id === op.targetId ? doc.root : findNode(doc.root, op.targetId)
      if (!node) return null
      return { op: 'replace', targetId: op.targetId, node: structuredClone(node) }
    }

    case 'move': {
      const found = findParent(doc.root, op.targetId)
      if (!found) return null
      return {
        op: 'move',
        targetId: op.targetId,
        parentId: found.parent.id,
        index: found.index
      }
    }

    case 'update': {
      const node = findNode(doc.root, op.targetId)
      if (!node) return null
      const patch: Partial<Pick<DesignNode, 'text' | 'style' | 'tag' | 'meta'>> = {}
      let expressible = true

      if (op.patch.text !== undefined) {
        if (node.text === undefined) expressible = false
        else patch.text = node.text
      }
      if (op.patch.tag !== undefined) {
        if (node.tag === undefined) expressible = false
        else patch.tag = node.tag
      }
      if (op.patch.style !== undefined) {
        const previous: Record<string, StyleTokenRef | string> = {}
        for (const key of Object.keys(op.patch.style)) {
          const old = node.style?.[key]
          if (old === undefined) {
            expressible = false
            break
          }
          previous[key] = old
        }
        if (expressible) patch.style = previous
      }
      if (op.patch.meta !== undefined) {
        const previous: NonNullable<DesignNode['meta']> = {}
        if (op.patch.meta.createdBy !== undefined) {
          if (!node.meta?.createdBy) expressible = false
          else previous.createdBy = structuredClone(node.meta.createdBy)
        }
        if (op.patch.meta.locked !== undefined) {
          if (node.meta?.locked === undefined) expressible = false
          else previous.locked = node.meta.locked
        }
        if (op.patch.meta.editedByUser !== undefined) {
          if (node.meta?.editedByUser === undefined) expressible = false
          else previous.editedByUser = node.meta.editedByUser
        }
        if (expressible) patch.meta = previous
      }

      if (!expressible) {
        return { op: 'replace', targetId: op.targetId, node: structuredClone(node) }
      }
      return { op: 'update', targetId: op.targetId, patch }
    }

    case 'token': {
      const old = doc.tokens[op.name]?.[op.key]
      return { op: 'token', name: op.name, key: op.key, value: old ?? '' }
    }
  }
}

/**
 * 计算一批 op 的反向序列。
 *
 * 用 applyPatch 逐个模拟（而不是一次性批量），因为同一批里后面的 op 可能依赖前面的结果
 * （insert 后再 update / remove 刚插入的节点）；只有逐步推进才拿得到每个 op 生效前的快照。
 * applyPatch 对单个 op 的判定与批量处理中的判定一致（批量也是顺序应用、单个失败不影响其它），
 * 所以这里的"被接受"集合与真正批量应用的结果一致。版本号/updatedAt 的模拟差异会被丢弃。
 */
function buildInverseBatch(
  before: DesignDocument,
  ops: PatchOp[],
  actor: PatchActor,
  options: PatchOptions
): { forward: PatchOp[]; inverse: PatchOp[] } {
  let working = before
  const forward: PatchOp[] = []
  const inverse: PatchOp[] = []
  for (const op of ops) {
    const step = applyPatch(working, [op], actor, options)
    if (step.rejected.length > 0 || step.applied === 0) continue
    const back = inverseOfOp(working, op)
    working = step.document
    if (!back) continue
    forward.push(op)
    inverse.push(back)
  }
  return { forward, inverse }
}

export class DesignService {
  private readonly root: string
  private readonly now: () => number
  private emit: DesignEventSink | undefined

  private projectId: string | null = null
  private doc: DesignDocument | null = null
  private dirty = false

  /** 会话内单调递增的 patch 步号（写入 provenance，不是文档 version）。 */
  private step = 0
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []

  constructor(deps: DesignServiceDeps = {}) {
    this.root = deps.root ?? designsRoot()
    this.now = deps.now ?? (() => Date.now())
    this.emit = deps.emit
  }

  /** 替换事件出口（IPC 注册时接上窗口转发；测试可传 noop）。 */
  setEmit(emit: DesignEventSink | undefined): void {
    this.emit = emit
  }

  /**
   * 打开项目。切换项目时先把上一个项目的脏文档落盘（open/close 写盘策略），
   * 避免"切走了最后几帧改动"丢失。重复打开同一项目是无操作。
   */
  open(projectId: string): DesignDocument {
    if (this.projectId === projectId && this.doc) return this.doc
    this.flush()
    this.projectId = projectId
    this.doc = loadDocument(projectId, this.root)
    this.dirty = false
    this.undoStack = []
    this.redoStack = []
    this.step = 0
    this.publishDocument()
    this.publishState()
    return this.doc
  }

  /** 关闭当前项目（脏文档先落盘）。 */
  close(): void {
    this.flush()
    this.projectId = null
    this.doc = null
    this.dirty = false
    this.undoStack = []
    this.redoStack = []
    this.publishState()
  }

  current(): DesignDocument {
    return this.requireDocument()
  }

  /**
   * 应用一批 patch。成功（applied > 0）才更新内存文档与 dirty、才压入撤销栈。
   * 不写盘；被拒绝的 op 原样返回原因（由调用方决定怎么展示）。
   */
  applyOps(
    actorId: string,
    ops: PatchOp[],
    opts: { allowLocked?: boolean } = {}
  ): ApplyOpsOutcome {
    const before = this.requireDocument()
    const actor: PatchActor = { actor: actorId, step: ++this.step, at: this.now() }
    const options: PatchOptions = { allowLocked: opts.allowLocked === true }
    // 隔离调用方对象：applyPatch 会把 node 引用直接放进新文档并在收尾时写 meta。
    const safeOps = cloneOps(ops)

    const simulation = buildInverseBatch(before, safeOps, actor, options)
    const result = applyPatch(before, safeOps, actor, options)

    if (result.applied > 0) {
      // 理论上 simulation 与批量应用逐 op 等价；万一不一致也不压栈（宁可不能撤销，不要撤错）。
      if (simulation.forward.length === result.applied) {
        this.undoStack.push({
          forward: cloneOps(simulation.forward),
          inverse: cloneOps(simulation.inverse),
          actor: actorId
        })
        this.redoStack = []
      }
      this.doc = result.document
      this.dirty = true
    }

    if (result.rejected.length > 0) {
      this.safeEmit({ type: 'rejected', actor: actorId, rejected: result.rejected })
    }
    if (result.applied > 0) {
      this.publishDocument()
      this.publishState()
    }
    return { applied: result.applied, rejected: result.rejected, doc: this.requireDocument() }
  }

  addConstraint(input: Omit<DesignConstraint, 'id' | 'at' | 'status'>): DesignDocument {
    const doc = this.requireDocument()
    if (!findNode(doc.root, input.targetId)) {
      throw new Error(`约束目标节点不存在：${input.targetId}`)
    }
    const next = addConstraintToDocument(doc, input)
    next.updatedAt = this.now()
    this.doc = next
    this.dirty = true
    this.publishDocument()
    this.publishState()
    return next
  }

  resolveConstraint(
    id: string,
    status: 'satisfied' | 'conflict',
    note?: string
  ): DesignDocument {
    if (status !== 'satisfied' && status !== 'conflict') {
      throw new Error(`未知的约束状态：${String(status)}`)
    }
    const doc = this.requireDocument()
    if (!doc.constraints.some((constraint) => constraint.id === id)) {
      throw new Error(`约束不存在：${id}`)
    }
    const next = resolveConstraintInDocument(doc, id, status, note)
    next.updatedAt = this.now()
    this.doc = next
    this.dirty = true
    this.publishDocument()
    this.publishState()
    return next
  }

  /** 设置某个块的变体候选（同时清掉旧的选择，因为候选已经换了）。 */
  setVariants(blockId: string, options: DesignNode[]): void {
    if (typeof blockId !== 'string' || blockId.trim().length === 0) throw new Error('blockId 不能为空')
    const doc = this.requireDocument()
    const next = structuredClone(doc)
    const existing = next.variants.find((variant) => variant.blockId === blockId)
    if (existing) {
      existing.options = structuredClone(options)
      existing.chosenIndex = undefined
    } else {
      next.variants.push({ blockId, options: structuredClone(options) })
    }
    next.version += 1
    next.updatedAt = this.now()
    this.doc = next
    this.dirty = true
    this.publishDocument()
    this.publishState()
  }

  chooseVariant(blockId: string, index: number): DesignDocument {
    const doc = this.requireDocument()
    const variant = doc.variants.find((entry) => entry.blockId === blockId)
    if (!variant) throw new Error(`变体不存在：${blockId}`)
    if (!Number.isInteger(index) || index < 0 || index >= variant.options.length) {
      throw new Error(`变体下标越界：${String(index)}（共 ${variant.options.length} 个候选）`)
    }
    const next = structuredClone(doc)
    const target = next.variants.find((entry) => entry.blockId === blockId)!
    target.chosenIndex = index
    next.version += 1
    next.updatedAt = this.now()
    this.doc = next
    this.dirty = true
    this.publishDocument()
    this.publishState()
    return next
  }

  /** 撤销最后一次成功的 applyOps（反向 patch，一次性撤销整批）。 */
  undo(): boolean {
    const doc = this.doc
    if (!doc) return false
    const entry = this.undoStack[this.undoStack.length - 1]
    if (!entry) return false
    const actor: PatchActor = { actor: 'system:undo', step: ++this.step, at: this.now() }
    const result = applyPatch(doc, cloneOps(entry.inverse).reverse(), actor, { allowLocked: true })
    // 一个都没恢复：保留撤销栈，别让"按了没反应"顺带把历史吃掉。
    if (result.applied === 0) return false
    this.undoStack.pop()
    this.redoStack.push(entry)
    this.doc = result.document
    this.dirty = true
    this.publishDocument()
    this.publishState()
    return true
  }

  /** 重做被撤销的那一批（重新应用当时的正向 op）。 */
  redo(): boolean {
    const doc = this.doc
    if (!doc) return false
    const entry = this.redoStack[this.redoStack.length - 1]
    if (!entry) return false
    const actor: PatchActor = { actor: entry.actor, step: ++this.step, at: this.now() }
    const result = applyPatch(doc, cloneOps(entry.forward), actor, { allowLocked: true })
    if (result.applied === 0) return false
    this.redoStack.pop()
    this.undoStack.push(entry)
    this.doc = result.document
    this.dirty = true
    this.publishDocument()
    this.publishState()
    return true
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /**
   * 提交一轮：ensureRepo（避免首次提交把本轮改动吞掉）→ 落盘 → git commit → rounds.log。
   * 无改动时 git 返回 skipped，同样把 dirty 归零（磁盘内容已经与 HEAD 一致）。
   */
  commitRound(summary: string): CommitOutcome {
    const projectId = this.projectId
    const doc = this.doc
    if (!projectId || !doc) return { ok: false, error: '尚未打开设计项目' }
    const dir = projectDir(this.root, projectId)
    const message = normalizeSummary(summary)

    // ensureRepo 先于落盘：全新目录此时只有 .gitignore，不会造"初始化"空提交，
    // 首轮 commitRound 就成为第一次提交（history 干净）。
    const repo = ensureRepo(dir)

    try {
      saveDocument(projectId, doc, this.root)
    } catch (error) {
      return { ok: false, error: `保存设计文档失败：${(error as Error).message}` }
    }
    if (!repo.ok) return { ok: false, error: repo.error ?? '设计工作区初始化失败' }

    const committed = commitRoundInGit(dir, message)
    if (!committed.ok) return { ok: false, error: committed.error ?? '提交失败' }

    this.dirty = false
    this.publishState()
    if (committed.skipped) return { ok: true, skipped: true }

    const sha = committed.sha ?? ''
    try {
      const line = [
        new Date(this.now()).toISOString(),
        message,
        sha || '(unknown)',
        documentFingerprint(doc)
      ].join(' | ')
      appendRoundLog(projectId, line, this.root)
    } catch (error) {
      // 提交已经成功，日志失败不回滚提交，但要把原因带回去让人知道。
      return {
        ok: true,
        ...(sha ? { sha } : {}),
        error: `轮次已提交，但 rounds.log 写入失败：${(error as Error).message}`
      }
    }
    return { ok: true, ...(sha ? { sha } : {}) }
  }

  history(limit = 20): GitHistoryEntry[] {
    if (!this.projectId) return []
    return historyInGit(projectDir(this.root, this.projectId), limit)
  }

  /**
   * 导出最近一轮（HEAD）为 zip。注意：导出的是**已提交**的内容，
   * 未 commit 的 applyOps 不在 zip 里（需要最新内容请先 commitRound）。
   */
  exportZip(targetPath: string): ExportOutcome {
    if (!this.projectId) return { ok: false, error: '尚未打开设计项目' }
    return exportZipInGit(projectDir(this.root, this.projectId), targetPath)
  }

  isDirty(): boolean {
    return this.doc !== null && this.dirty
  }

  state(): DesignStateSnapshot {
    return {
      projectId: this.projectId,
      version: this.doc?.version ?? 0,
      dirty: this.isDirty(),
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      updatedAt: this.doc?.updatedAt ?? null
    }
  }

  // ------------------------------------------------------------ internals

  private requireDocument(): DesignDocument {
    if (!this.doc) throw new Error('尚未打开设计项目')
    return this.doc
  }

  /** open 切换项目 / close 时把脏文档落盘；失败会抛出（不悄悄丢改动）。 */
  private flush(): void {
    if (!this.projectId || !this.doc || !this.dirty) return
    saveDocument(this.projectId, this.doc, this.root)
    this.dirty = false
  }

  private safeEmit(event: DesignServiceEvent): void {
    try {
      this.emit?.(event)
    } catch {
      /* 事件出口坏了不能影响设计文档本身 */
    }
  }

  private publishDocument(): void {
    if (!this.doc || !this.projectId) return
    this.safeEmit({ type: 'document', projectId: this.projectId, document: this.doc })
  }

  private publishState(): void {
    this.safeEmit({ type: 'state', state: this.state() })
  }
}
