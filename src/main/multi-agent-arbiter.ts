/**
 * 多 agent 共用一个标签的仲裁器（实验版）。
 *
 * 三条规则来自产品讨论，这里把每条都做成可测的行为，而不是注释里的愿望：
 *
 *  1. **导航屏障**：要跳转的 agent 必须等该标签上其它 agent 的操作结束。
 *     等待有上限（默认 3s），超时才抢占——否则一个卡住的 agent 会永久锁死导航。
 *  2. **误跳转回退**：如果跳转还是发生了（页面自己重定向、脚本跳转、或抢占后），
 *     立即急停其它在途操作，并把"应该回退到哪里"交给调用方去回退，
 *     被中断的 agent 拿到的是**明确的失败**，不是静默的脏状态。
 *  3. **争用排序**：同一目标（同一个按钮/输入框）的动作用权重串行化；
 *     权重相同按发起顺序。串行意味着**永远不会有两个 agent 同时按同一个键**。
 *
 * 这个类不碰 Electron、不碰 DOM，时间与随机性都可注入，所以能直接单测。
 */

export interface OperationToken {
  readonly id: number
  readonly actorId: string
  readonly tabId: number
  readonly startedAt: number
  aborted: boolean
  abortReason?: string
}

export interface NavigateDecision {
  ok: boolean
  /** 等待了多久（毫秒）。屏障命中时 > 0。 */
  waitedMs: number
  /** 被抢占（急停）的其它 agent。 */
  preempted: string[]
  /** 等待超时被抢占时为 true，便于报告里区分"主动等"与"等不到"。 */
  timedOut: boolean
}

export interface ArbiterOptions {
  now?: () => number
  /** 导航屏障默认上限。 */
  navTimeoutMs?: number
  /** 轮询间隔，仅测试需要调小。 */
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_NAV_TIMEOUT_MS = 3000
const DEFAULT_POLL_MS = 25

/** 稳定的字符串哈希（FNV-1a），用来把 agent id 映射成默认权重。 */
function stableHash(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export class MultiAgentArbiter {
  private readonly ops = new Map<number, Map<number, OperationToken>>()
  private seq = 0
  private readonly now: () => number
  private readonly navTimeoutMs: number
  private readonly pollMs: number
  private readonly sleep: (ms: number) => Promise<void>
  /** 显式权重覆盖：actorId -> 权重（小的先执行）。 */
  private readonly weights = new Map<string, number>()
  /** 正在持有 (tab::target) 的键；持有者持有期间新的请求一律排队。 */
  private readonly activeTargets = new Set<string>()
  /** 每个 (tab::target) 的等待队列。释放时按权重把持有权**移交**给队首。 */
  private readonly targetQueues = new Map<
    string,
    Array<{ actorId: string; seq: number; wake: () => void }>
  >()

  constructor(options: ArbiterOptions = {}) {
    this.now = options.now ?? Date.now
    this.navTimeoutMs = options.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** 显式指定权重，覆盖默认的哈希权重。 */
  setWeight(actorId: string, weight: number): void {
    this.weights.set(actorId, weight)
  }

  /**
   * agent 的争用权重：**小的先执行**。
   *
   * 优先级顺序：
   *  1. 显式 `setWeight()`；
   *  2. id 末尾的数字（"agent-3" → 3），这就是"按 agent 编号加权排序"的字面含义；
   *  3. 没有编号（如外部 MCP 客户端的随机 id）时用稳定哈希，保证同一 id 每次都同权重。
   */
  priorityOf(actorId: string): number {
    const explicit = this.weights.get(actorId)
    if (explicit !== undefined) return explicit
    const numbered = /(\d+)\s*$/.exec(actorId)
    if (numbered) return Number(numbered[1])
    return stableHash(actorId) % 1000
  }

  /** 登记一次在途操作。 */
  beginOperation(actorId: string, tabId: number): OperationToken {
    const token: OperationToken = {
      id: ++this.seq,
      actorId,
      tabId,
      startedAt: this.now(),
      aborted: false
    }
    const byTab = this.ops.get(tabId) ?? new Map<number, OperationToken>()
    byTab.set(token.id, token)
    this.ops.set(tabId, byTab)
    return token
  }

  endOperation(token: OperationToken): void {
    this.ops.get(token.tabId)?.delete(token.id)
  }

  /** 该标签上除 `excludeActorId` 之外的在途操作。 */
  activeOperations(tabId: number, excludeActorId?: string): OperationToken[] {
    const byTab = this.ops.get(tabId)
    if (!byTab) return []
    return [...byTab.values()].filter((token) => token.actorId !== excludeActorId)
  }

  /**
   * 动作发出前的检查：被抢占过的 token 必须**失败**，并带上回退提示。
   * 这是"不能静默继续"的执行点——脏状态就是从这里被挡住的。
   */
  assertNotAborted(token: OperationToken, action: string): void {
    if (!token.aborted) return
    throw new Error(
      `[ARBITER] 该 ${action} 已被中断：${token.abortReason ?? '其它 agent 发起了导航'}。` +
        `请先重新观察页面再决定下一步，不要重试刚才的动作。`
    )
  }

  /**
   * 导航屏障：等该标签上其它 agent 的操作结束。
   * 超时后**抢占**（急停它们）并放行，避免导航被一个卡死的 agent 永久阻塞。
   */
  async requestNavigation(
    actorId: string,
    tabId: number,
    options: { timeoutMs?: number; force?: boolean } = {}
  ): Promise<NavigateDecision> {
    const startedAt = this.now()
    const timeoutMs = options.timeoutMs ?? this.navTimeoutMs
    if (options.force) {
      const preempted = this.abortOthers(tabId, actorId, `agent ${actorId} 强制导航`)
      return { ok: true, waitedMs: 0, preempted, timedOut: false }
    }
    while (this.activeOperations(tabId, actorId).length > 0) {
      if (this.now() - startedAt >= timeoutMs) {
        const preempted = this.abortOthers(
          tabId,
          actorId,
          `等待超过 ${timeoutMs}ms，agent ${actorId} 的导航抢占`
        )
        return { ok: true, waitedMs: this.now() - startedAt, preempted, timedOut: true }
      }
      await this.sleep(this.pollMs)
    }
    return { ok: true, waitedMs: this.now() - startedAt, preempted: [], timedOut: false }
  }

  /** 急停该标签上除 `actorId` 之外的所有操作，返回被停掉的 agent 列表。 */
  abortOthers(tabId: number, actorId: string, reason: string): string[] {
    const stopped: string[] = []
    for (const token of this.activeOperations(tabId, actorId)) {
      token.aborted = true
      token.abortReason = reason
      stopped.push(token.actorId)
    }
    return [...new Set(stopped)]
  }

  /**
   * 页面已经跳走了（自己重定向/脚本跳转/抢占后）时的处理：
   * 急停其它操作，并告诉调用方应该回退到哪个地址继续。
   */
  handleUnexpectedNavigation(
    tabId: number,
    actingActorId: string,
    previousUrl: string
  ): { stopped: string[]; rollbackTo: string } {
    const stopped = this.abortOthers(tabId, actingActorId, '页面被跳转，操作已中断')
    return { stopped, rollbackTo: previousUrl }
  }

  /**
   * 同一目标的串行化：同 (tab, target) 只有一个执行者。
   *
   * 关键点是**持有权移交**而不是"排队等唤醒"：正在执行的人不会被后来的更高权重插队，
   * 释放时把持有权直接交给等待队列里权重最高（编号最小）的那个。这样既保证互斥，
   * 又让争用按权重排序。
   */
  async withTarget<T>(
    actorId: string,
    tabId: number,
    targetKey: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = `${tabId}::${targetKey}`

    if (!this.activeTargets.has(key)) {
      this.activeTargets.add(key)
      try {
        return await fn()
      } finally {
        this.releaseTarget(key)
      }
    }

    await new Promise<void>((resolve) => {
      const queue = this.targetQueues.get(key) ?? []
      queue.push({ actorId, seq: ++this.seq, wake: resolve })
      this.targetQueues.set(key, queue)
    })
    // 被唤醒即已获得持有权
    try {
      return await fn()
    } finally {
      this.releaseTarget(key)
    }
  }

  /** 释放持有权：有等待者就按权重移交，否则彻底释放。 */
  private releaseTarget(key: string): void {
    const queue = this.targetQueues.get(key) ?? []
    if (queue.length === 0) {
      this.targetQueues.delete(key)
      this.activeTargets.delete(key)
      return
    }
    queue.sort(
      (a, b) => this.priorityOf(a.actorId) - this.priorityOf(b.actorId) || a.seq - b.seq
    )
    const next = queue.shift()!
    if (queue.length === 0) this.targetQueues.delete(key)
    next.wake()
  }
}
