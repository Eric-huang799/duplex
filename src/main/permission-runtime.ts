/**
 * 站点权限的运行时：把「策略内核 + 存储」接到 Electron 的 Session 上。
 *
 * 职责：
 *  - 把 Electron 的原始权限名换算成类别，算出 origin，走决策引擎
 *  - `ask` 时向用户发问（去重 / 限流 / 超时 / fail-closed）
 *  - `allow`/`deny` 决定写回存储（用户点「记住」时由上层处理）
 *
 * 产品原则：AI 在安全范围内可以做一切有益于用户的事情——
 * 所以**只有决策引擎说 `ask` 的类别才会打扰用户**，其余静默放行或拒绝。
 */
import type { Session, WebContents } from 'electron'
import { categoryForPermission } from './permission-policy'
import type { PermissionStore } from './permission-store'
import { metaOf, originOfUrl, resolveDecision, type PermissionCategory } from '../shared/permissions'

export type PromptAnswer = 'allow' | 'allow-session' | 'deny'

export interface PermissionPrompt {
  id: number
  /** 规范化 origin（由主进程计算，绝不采信页面或渲染层给的值）。 */
  origin: string
  /** 跨源 iframe 时，顶层页面的 origin（便于用户判断"谁在要"）。 */
  topOrigin?: string
  category: PermissionCategory
  tabId: number | null
}

export interface PermissionRuntimeDeps {
  store: PermissionStore
  /** 该 WebContents 属于哪个标签（应用窗口/未知 → null）。 */
  tabIdOf: (wc: WebContents | null) => number | null
  /** 顶层页面的 origin（用于跨源提示）。 */
  topOriginOf: (wc: WebContents | null) => string | null
  /** AI 是否处于暂停/急停。 */
  isAiPaused: () => boolean
  /** 该标签是否正被 AI 的写操作持有。 */
  isTabDriven: (tabId: number | null) => boolean
  /** 现在能不能打扰用户（窗口可见、标签活跃…）。不能则直接拒绝。 */
  canPrompt: (tabId: number | null) => boolean
  /** 向用户发问。**必须自己处理超时**，超时应返回 deny。 */
  ask: (prompt: PermissionPrompt) => Promise<PromptAnswer>
  log: (line: string) => void
}

/** 同一 (origin, 类别) 的拒绝次数在窗口内超过阈值后静默拒绝，防止刷弹窗。 */
const DENY_WINDOW_MS = 60_000
const DENY_LIMIT = 3

export class PermissionRuntime {
  /** 正在等待用户回答的询问，键见 `promptKey`。 */
  private pending = new Map<string, Promise<boolean>>()
  private denyStreak = new Map<string, { count: number; since: number }>()
  private seq = 0

  constructor(private readonly deps: PermissionRuntimeDeps) {}

  /** 给一个 Session 装上处理器。`ephemeral` 的会话不落盘（隐身分区）。 */
  attach(session: Session, options: { ephemeral?: boolean } = {}): void {
    const ephemeral = options.ephemeral === true
    try {
      session.setPermissionCheckHandler((wc, permission) => this.check(wc, permission, ephemeral))
      session.setPermissionRequestHandler((wc, permission, callback, details) => {
        void this.handle(wc, permission, details, ephemeral).then(
          (allowed) => callback(allowed),
          (error: unknown) => {
            this.deps.log(`[permissions] 处理 ${permission} 时出错，按拒绝处理：${(error as Error)?.message ?? error}`)
            callback(false)
          }
        )
      })
    } catch (error) {
      this.deps.log(`[permissions] 注册权限处理器失败：${(error as Error)?.message ?? error}`)
    }
  }

  // ── 决策 ────────────────────────────────────────────────────────────────

  private resolve(
    wc: WebContents | null,
    permission: string,
    requestingUrl?: string
  ): { category: PermissionCategory; origin: string | null; tabId: number | null; decision: ReturnType<typeof resolveDecision> } | null {
    const category = categoryForPermission(permission)
    if (!category) {
      this.deps.log(`[permissions] 未知权限 ${permission}，按拒绝处理`)
      return null
    }
    const origin = originOfUrl(requestingUrl) ?? originOfUrl(wc?.getURL() ?? '')
    const tabId = this.deps.tabIdOf(wc)
    const driven = this.deps.isTabDriven(tabId)
    const decision = resolveDecision({
      category,
      rule: origin ? this.deps.store.ruleFor(origin) : null,
      global: this.deps.store.globalDecisions(),
      sessionGrant: origin ? this.deps.store.isSessionGranted(origin, category) : false,
      fromAgent: driven,
      aiPaused: this.deps.isAiPaused(),
      aiDriving: driven
    })
    return { category, origin, tabId, decision }
  }

  /**
   * 同步预检。**只有在决策为 `allow` 时返回 true**——`ask` 必须返回 false，
   * 否则 Chromium 认为已有答案，请求处理器根本不会被调用，用户永远看不到提示。
   */
  private check(wc: WebContents | null, permission: string, _ephemeral: boolean): boolean {
    const resolved = this.resolve(wc, permission)
    if (!resolved) return false
    return resolved.decision === 'allow'
  }

  private async handle(
    wc: WebContents | null,
    permission: string,
    details: { requestingUrl?: string; isMainFrame?: boolean } | undefined,
    ephemeral: boolean
  ): Promise<boolean> {
    const resolved = this.resolve(wc, permission, details?.requestingUrl)
    if (!resolved) return false
    const { category, origin, tabId, decision } = resolved
    if (decision === 'allow') return true
    if (decision === 'deny') return false

    // decision === 'ask'
    if (!origin) return false // 没有 origin 无从记忆，直接拒绝
    if (!this.deps.canPrompt(tabId)) {
      this.deps.log(`[permissions] ${origin} 请求 ${category}，但当前不适合打扰用户 → 拒绝`)
      return false
    }
    if (this.isDenyStreak(origin, category)) {
      this.deps.log(`[permissions] ${origin} 的 ${category} 近期被多次拒绝 → 静默拒绝`)
      return false
    }

    const key = `${ephemeral ? 'e:' : 'p:'}${origin}|${category}|${tabId ?? '-'}`
    const inflight = this.pending.get(key)
    if (inflight) return inflight

    const run = (async (): Promise<boolean> => {
      const id = ++this.seq
      const prompt: PermissionPrompt = {
        id,
        origin,
        category,
        tabId,
        ...(this.deps.topOriginOf(wc) ? { topOrigin: this.deps.topOriginOf(wc) as string } : {})
      }
      let answer: PromptAnswer
      try {
        answer = await this.deps.ask(prompt)
      } catch (error) {
        this.deps.log(`[permissions] 询问失败，按拒绝处理：${(error as Error)?.message ?? error}`)
        answer = 'deny'
      }
      if (answer === 'deny') {
        this.recordDeny(origin, category)
        return false
      }
      // 隐身分区不落盘：即使用户选了「记住」，也只作用于本次会话。
      if (answer === 'allow-session' || ephemeral) {
        this.deps.store.grantForSession(origin, category)
      } else {
        const result = this.deps.store.set(origin, category, 'allow', 'user')
        if (!result.ok) {
          this.deps.log(`[permissions] 保存 ${origin} → ${category} 失败：${result.error}`)
          this.deps.store.grantForSession(origin, category)
        }
      }
      this.deps.log(`[permissions] ${origin} 允许 ${category}（${answer}${ephemeral ? '，隐身不落盘' : ''}）`)
      return true
    })()

    this.pending.set(key, run)
    try {
      return await run
    } finally {
      this.pending.delete(key)
    }
  }

  // ── 限流 ────────────────────────────────────────────────────────────────

  private isDenyStreak(origin: string, category: PermissionCategory): boolean {
    const entry = this.denyStreak.get(`${origin}|${category}`)
    if (!entry) return false
    if (Date.now() - entry.since > DENY_WINDOW_MS) {
      this.denyStreak.delete(`${origin}|${category}`)
      return false
    }
    return entry.count >= DENY_LIMIT
  }

  private recordDeny(origin: string, category: PermissionCategory): void {
    const key = `${origin}|${category}`
    const now = Date.now()
    const entry = this.denyStreak.get(key)
    if (!entry || now - entry.since > DENY_WINDOW_MS) {
      this.denyStreak.set(key, { count: 1, since: now })
      return
    }
    entry.count += 1
  }

  /** 某类别的对外可见说明（提示条用），避免渲染层自己拼文案。 */
  describe(category: PermissionCategory): { labelKey: string; tier: string } {
    const meta = metaOf(category)
    return { labelKey: meta.labelKey, tier: meta.tier }
  }
}
