/**
 * snapshot ref 的命名空间与指纹（只存在主进程内存）。
 *
 * 背景：`snapshot` 返回的 `[eN]` 是快照内编号。多个 agent 共用一个标签时，
 * 各自拿到的 ref 不能混用；页面几经变化后，旧 ref 也不该继续点到"长得像"的节点。
 *
 * 分工：
 *  - **命名空间**：多 agent 会话里 ref 显示为 `a<actor>:eN`；解析时前缀必须等于
 *    当前调用者的命名空间，否则明确报错，绝不把别人的 ref 当成自己的元素。
 *  - **指纹**：snapshot 时页面脚本把每个 ref 的轻量指纹（标签 + 文本前 N 字 +
 *    文档内位置 + href/type）随大纲一起返回，这里按 (标签, actor) 保存；
 *    动作前再只读探测一次当前值并比对，不一致就判 ref 作废。
 *
 * 页面里**不新增**任何 DOM 属性或全局变量：指纹只在快照返回值和本模块之间流动。
 */

export interface RefFingerprint {
  /** 小写标签名，如 button。 */
  tag: string
  /** 空白归一化后的文本前 FINGERPRINT_TEXT_LIMIT 个字符。 */
  text: string
  /** 文档内坐标（视口坐标 + 滚动量），避免用户滚动页面造成误判。 */
  x: number
  y: number
  w: number
  h: number
  href: string
  type: string
}

export interface SnapshotRefEntry {
  /** 快照内编号，形如 e12（不含 agent 前缀）。 */
  ref: string
  fingerprint: RefFingerprint
}

export interface SnapshotEnvelope {
  /** 给模型看的 DOM 大纲（不含内部指纹尾部）。 */
  outline: string
  /** 页面文档令牌，用于识别"导航/刷新后同名 ref 指向新文档"。 */
  documentToken: string
  refs: SnapshotRefEntry[]
}

/** snapshot 返回值里内部指纹尾部的分隔标记（普通页面文本几乎不可能包含）。 */
export const SNAPSHOT_REF_MARKER = '\n\u001fCobrowseRefs\u001f'

/** 指纹里保留的文本长度。 */
export const FINGERPRINT_TEXT_LIMIT = 60

/** 位置/尺寸比对容差（像素）：吸收子像素取整与轻微 reflow。 */
export const POSITION_TOLERANCE_PX = 2

/** 每个 actor 在每个标签上保留的快照代数（与页面脚本的"最近三次"对齐）。 */
export const MAX_SNAPSHOTS_PER_ACTOR = 3

/** 长时间没有新快照的 actor 状态会被清理，避免标签长期打开时无限增长。 */
export const IDLE_ACTOR_TTL_MS = 30 * 60 * 1000

const PLAIN_REF = /^e\d+$/
const NAMESPACED_REF = /^a(.+):(e\d+)$/

export type ParsedRefTarget =
  | { kind: 'selector' }
  | { kind: 'ref'; baseRef: string; namespace: string | null }

/** `e12` / `a<actor>:e12` 视为 ref，其余按 CSS 选择器处理。 */
export function parseRefTarget(target: string): ParsedRefTarget {
  const namespaced = NAMESPACED_REF.exec(target)
  if (namespaced) {
    return { kind: 'ref', baseRef: namespaced[2], namespace: namespaced[1] }
  }
  if (PLAIN_REF.test(target)) return { kind: 'ref', baseRef: target, namespace: null }
  return { kind: 'selector' }
}

export function isRefTarget(target: string): boolean {
  return parseRefTarget(target).kind === 'ref'
}

/** 统一指纹形状：页面脚本已归一化，这里再兜一次底，主进程不信任页面返回值。 */
export function normalizeFingerprint(
  value: Partial<RefFingerprint> | null | undefined
): RefFingerprint {
  const int = (raw: unknown): number => {
    const n = Number(raw)
    return Number.isFinite(n) ? Math.round(n) : 0
  }
  return {
    tag: String(value?.tag ?? '').toLowerCase(),
    text: String(value?.text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, FINGERPRINT_TEXT_LIMIT),
    x: int(value?.x),
    y: int(value?.y),
    w: int(value?.w),
    h: int(value?.h),
    // Keep the same caps as the page helper so a huge href/data: URL cannot
    // bloat the snapshot payload or memory.
    href: String(value?.href ?? '').slice(0, 160),
    type: String(value?.type ?? '')
      .toLowerCase()
      .slice(0, 32)
  }
}

export interface FingerprintComparison {
  match: boolean
  /** 人读的变化描述，用于"元素已被改动"的报错。 */
  changed: string[]
}

function displayText(value: string): string {
  const one = value.replace(/\s+/g, ' ').trim()
  return one.length > 24 ? one.slice(0, 24) + '…' : one
}

/** 比对快照指纹与动作前探测到的当前指纹。 */
export function compareFingerprints(
  stored: RefFingerprint,
  current: RefFingerprint,
  tolerance = POSITION_TOLERANCE_PX
): FingerprintComparison {
  const changed: string[] = []
  if (stored.tag !== current.tag) changed.push(`标签 ${stored.tag || '?'} → ${current.tag || '?'}`)
  if (stored.text !== current.text) {
    changed.push(`文本 "${displayText(stored.text)}" → "${displayText(current.text)}"`)
  }
  if (Math.abs(stored.x - current.x) > tolerance || Math.abs(stored.y - current.y) > tolerance) {
    changed.push(`位置 (${stored.x},${stored.y}) → (${current.x},${current.y})`)
  }
  if (Math.abs(stored.w - current.w) > tolerance || Math.abs(stored.h - current.h) > tolerance) {
    changed.push(`尺寸 ${stored.w}x${stored.h} → ${current.w}x${current.h}`)
  }
  if (stored.href !== current.href) changed.push('href 变化')
  if (stored.type !== current.type) changed.push('type 变化')
  return { match: changed.length === 0, changed }
}

export type RefErrorCode = 'FOREIGN_REF' | 'UNKNOWN_REF' | 'STALE_REF' | 'NOT_A_REF'

export class RefError extends Error {
  readonly code: RefErrorCode
  constructor(code: RefErrorCode, message: string) {
    super(message)
    this.name = 'RefError'
    this.code = code
  }
}

export interface RefSnapshotRecord {
  documentToken: string
  capturedAt: number
  refs: Map<string, RefFingerprint>
}

export interface RefClaim {
  actorId: string
  /** 去掉命名空间后的快照内编号，页面 refMap 用它。 */
  baseRef: string
  snapshot: RefSnapshotRecord
}

interface ActorRecord {
  snapshots: RefSnapshotRecord[]
  updatedAt: number
}

interface TabRecord {
  actors: Map<string, ActorRecord>
  updatedAt: number
}

export interface RefRegistryOptions {
  now?: () => number
  maxSnapshotsPerActor?: number
  idleTtlMs?: number
}

/**
 * 按 (标签, actor) 保存 ref 指纹，并负责命名空间解析与过期判断。
 * 纯内存、无 Electron 依赖，可直接单测。
 */
export class RefRegistry {
  private readonly tabs = new Map<number, TabRecord>()
  private readonly now: () => number
  private readonly maxSnapshots: number
  private readonly idleTtlMs: number

  constructor(options: RefRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxSnapshots = Math.max(1, options.maxSnapshotsPerActor ?? MAX_SNAPSHOTS_PER_ACTOR)
    this.idleTtlMs = Math.max(0, options.idleTtlMs ?? IDLE_ACTOR_TTL_MS)
  }

  /**
   * 用于拼进 ref 前缀的稳定短标识。
   *
   * 不能包含冒号：ref 的语法是 `a<tag>:e12`，而内置并行会话的 caller 形如
   * `builtin:demo-a`，直接拼出来会是 `abuiltin:demo-a:e12`——语义相同但可读性差，
   * 且让"最后一个冒号前是命名空间"的解析规则变得脆弱。这里把冒号也换成短横线。
   */
  actorTag(actorId: string): string {
    const tag = String(actorId || 'agent')
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 64)
    return tag || 'agent'
  }

  /** 多 agent 会话里对外展示的写法：a<actor>:e12。 */
  formatRef(actorId: string, baseRef: string): string {
    return `a${this.actorTag(actorId)}:${baseRef}`
  }

  /** 当前标签上是否已有别的 actor 的（未过期的）快照，决定 snapshot 是否输出命名空间。 */
  hasOtherActor(tabId: number, actorId: string): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab) return false
    const now = this.now()
    for (const [id, actor] of tab.actors) {
      if (id === actorId || actor.snapshots.length === 0) continue
      if (this.idleTtlMs <= 0 || now - actor.updatedAt <= this.idleTtlMs) return true
    }
    return false
  }

  /** 记录一次 snapshot：同一 actor 只保留最近 N 代，旧代数由 claim 自然判过期。 */
  recordSnapshot(
    tabId: number,
    actorId: string,
    documentToken: string,
    entries: ReadonlyArray<SnapshotRefEntry>
  ): void {
    this.pruneIdle()
    const now = this.now()
    const tab = this.tabs.get(tabId) ?? { actors: new Map(), updatedAt: now }
    const actor = tab.actors.get(actorId) ?? { snapshots: [], updatedAt: now }
    const refs = new Map<string, RefFingerprint>()
    for (const entry of entries) {
      // 页面返回的是不可信数据：只接受单次快照内的 eN 编号。
      if (!PLAIN_REF.test(entry.ref)) continue
      refs.set(entry.ref, normalizeFingerprint(entry.fingerprint))
    }
    actor.snapshots.push({ documentToken: documentToken || '', capturedAt: now, refs })
    while (actor.snapshots.length > this.maxSnapshots) actor.snapshots.shift()
    actor.updatedAt = now
    tab.actors.set(actorId, actor)
    tab.updatedAt = now
    this.tabs.set(tabId, tab)
  }

  /**
   * 解析一个 ref 并确认它属于当前 actor 的命名空间。
   * 带前缀且与当前 caller 不符时抛 FOREIGN_REF（明确失败，不落到别人的元素上）。
   */
  claim(tabId: number, actorId: string, target: string): RefClaim {
    const parsed = parseRefTarget(target)
    if (parsed.kind !== 'ref') {
      throw new RefError('NOT_A_REF', `"${target}" 不是 snapshot ref（应以 eN 或 a<actor>:eN 结尾）`)
    }
    const tag = this.actorTag(actorId)
    if (parsed.namespace !== null && parsed.namespace !== tag) {
      throw new RefError(
        'FOREIGN_REF',
        `ref "${target}" 属于 agent "${parsed.namespace}" 的命名空间，当前调用者是 "${actorId}"（命名空间 ${tag}）。` +
          `不能把别的 agent 的 ref 当作自己的元素；请调用 snapshot 获取你自己的 ref。`
      )
    }
    const actor = this.tabs.get(tabId)?.actors.get(actorId)
    if (actor) {
      for (let i = actor.snapshots.length - 1; i >= 0; i--) {
        const snapshot = actor.snapshots[i]
        if (snapshot.refs.has(parsed.baseRef)) return { actorId, baseRef: parsed.baseRef, snapshot }
      }
    }
    const owners = this.ownersOf(tabId, parsed.baseRef, actorId)
    if (owners.length > 0) {
      throw new RefError(
        'FOREIGN_REF',
        `ref "${target}" 不在你最近的 snapshot 中；它属于 agent ${owners.map((id) => `"${id}"`).join('、')} 的命名空间。` +
          `多 agent 会话请使用 "a${tag}:<你的 ref>"，或重新 snapshot 获取自己的 ref。`
      )
    }
    throw new RefError(
      'UNKNOWN_REF',
      `ref "${parsed.baseRef}" 不在你最近的 snapshot 中（可能已过期或旧快照已被清理）；请重新 snapshot。`
    )
  }

  /** 动作前用当前页面读数校验指纹；不一致就抛 STALE_REF。 */
  validate(claim: RefClaim, documentToken: string, current: RefFingerprint): void {
    const stored = claim.snapshot.refs.get(claim.baseRef)
    if (!stored) {
      throw new RefError(
        'UNKNOWN_REF',
        `ref "${claim.baseRef}" 已不在快照记录中；请重新 snapshot。`
      )
    }
    const before = claim.snapshot.documentToken
    const now = documentToken || ''
    // data-page-token 在极早期可能尚未写入（两侧都可能读到 unmarked），此时只靠指纹。
    if (
      before &&
      now &&
      before !== 'unmarked' &&
      now !== 'unmarked' &&
      before !== now
    ) {
      throw new RefError(
        'STALE_REF',
        `页面已导航或重新加载，ref "${claim.baseRef}" 已失效；请重新 snapshot。`
      )
    }
    const comparison = compareFingerprints(stored, normalizeFingerprint(current))
    if (!comparison.match) {
      throw new RefError(
        'STALE_REF',
        `元素已被改动，请重新 snapshot。ref "${claim.baseRef}" 的${comparison.changed.join('；')}。`
      )
    }
  }

  /** 释放一个标签的全部 ref 数据（关标签时调用）。 */
  forgetTab(tabId: number): void {
    this.tabs.delete(tabId)
  }

  /** 按 (标签, actor) 清理：只删这个 actor，不影响同标签上其他 agent。 */
  forgetActor(tabId: number, actorId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    tab.actors.delete(actorId)
    if (tab.actors.size === 0) this.tabs.delete(tabId)
    else tab.updatedAt = this.now()
  }

  /** 某个 caller 断开时清理它在所有标签上的数据。 */
  forgetActorEverywhere(actorId: string): void {
    for (const [tabId, tab] of this.tabs) {
      tab.actors.delete(actorId)
      if (tab.actors.size === 0) this.tabs.delete(tabId)
    }
  }

  /** 清理太长时间没有新快照的 actor（默认 30 分钟），防止标签长期存活时无限增长。 */
  pruneIdle(now = this.now()): void {
    if (this.idleTtlMs <= 0) return
    for (const [tabId, tab] of this.tabs) {
      for (const [actorId, actor] of tab.actors) {
        if (now - actor.updatedAt > this.idleTtlMs) tab.actors.delete(actorId)
      }
      if (tab.actors.size === 0) this.tabs.delete(tabId)
    }
  }

  hasActor(tabId: number, actorId: string): boolean {
    return this.tabs.get(tabId)?.actors.has(actorId) === true
  }

  snapshotCount(tabId: number, actorId: string): number {
    return this.tabs.get(tabId)?.actors.get(actorId)?.snapshots.length ?? 0
  }

  /** 同标签上其他 actor 是否恰好记录了某个 base ref（用于"这是别人的 ref"提示）。 */
  private ownersOf(tabId: number, baseRef: string, except: string): string[] {
    const tab = this.tabs.get(tabId)
    if (!tab) return []
    const owners: string[] = []
    for (const [actorId, actor] of tab.actors) {
      if (actorId === except) continue
      if (actor.snapshots.some((snapshot) => snapshot.refs.has(baseRef))) owners.push(actorId)
    }
    return owners
  }
}

/** 从 snapshot 返回值里拆出大纲与内部指纹数据；没有标记时返回 null。 */
export function parseSnapshotEnvelope(raw: string): SnapshotEnvelope | null {
  const index = raw.lastIndexOf(SNAPSHOT_REF_MARKER)
  if (index < 0) return null
  const outline = raw.slice(0, index)
  try {
    const payload = JSON.parse(raw.slice(index + SNAPSHOT_REF_MARKER.length)) as {
      documentToken?: unknown
      refs?: unknown
    }
    const refs: SnapshotRefEntry[] = []
    if (Array.isArray(payload.refs)) {
      for (const rawEntry of payload.refs) {
        if (!rawEntry || typeof rawEntry !== 'object') continue
        const entry = rawEntry as { ref?: unknown; fingerprint?: unknown }
        if (typeof entry.ref !== 'string' || !PLAIN_REF.test(entry.ref)) continue
        refs.push({
          ref: entry.ref,
          fingerprint: normalizeFingerprint(entry.fingerprint as Partial<RefFingerprint>)
        })
      }
    }
    return {
      outline,
      documentToken: typeof payload.documentToken === 'string' ? payload.documentToken : '',
      refs
    }
  } catch {
    // 元数据坏了也不能把控制字符尾部漏给模型：仍然只返回大纲。
    return { outline, documentToken: '', refs: [] }
  }
}

/** 进程内单例：工具执行链共用同一份 ref 状态。 */
export const refRegistry = new RefRegistry()
