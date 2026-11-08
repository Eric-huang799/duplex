/**
 * 并行内置 agent 会话。
 *
 * 现状：`AgentRuntime` 一个实例装所有会话，同一时刻只跑一个（单 `activeDone`/单队列）。
 * 这个模块让**额外的会话**各自拥有一个 runtime 实例、跑在自己的调用链上，
 * 从而真正做到多个内置 agent 同时工作；主实例仍负责 UI 当前会话，互不干扰。
 *
 * 三个关键点：
 *  1. **身份**：每个后台会话的工具调用都包在 `withCaller('builtin:<id>')` 里，
 *     授权、ref 命名空间、仲裁因此按会话隔离（而不是全部落到 'builtin'）。
 *  2. **存储合并**：后台 runtime 只知道自己那一个会话；保存时**重新读盘并只替换自己的 id**，
 *     避免把别的会话（包括主实例正在写的）覆盖掉。
 *  3. **事件带 sessionId**：渲染层能把事件归到对应会话，而不是混进当前对话。
 */
import { createHash } from 'node:crypto'
import { AgentRuntime } from './runtime'
import type { AgentSession } from './store'
import { loadAgentSessions, saveAgentSessions, trimSessionsForSave } from './store'
import type { ChatStreamOptions, ChatStreamResult } from './llm/types'
import { chatStream } from './llm'

export type SessionChatFn = (opts: ChatStreamOptions) => Promise<ChatStreamResult>

export interface SessionRunnerOptions {
  /** 该会话的工具执行器工厂：必须把调用包进它的身份里（见模块注释）。 */
  makeExecutor: (sessionId: string) => (name: string, args: Record<string, unknown>) => Promise<unknown>
  getConfig: () => unknown
  emit: (sessionId: string, event: Record<string, unknown>) => void
  makeSession?: () => AgentSession
  /** 后台会话使用的标签：默认取当前活动标签。 */
  getActiveTabId?: () => number | null
  /** 每次运行开始/结束时回调，用于把会话绑定到标签（协作锁按 caller 记账）。 */
  onStart?: (callerId: string, tabId?: number) => void
  onEnd?: (callerId: string) => void
  chatFn?: SessionChatFn
  load?: () => AgentSession[]
  save?: (sessions: AgentSession[]) => void
}

interface RunningSession {
  sessionId: string
  runtime: AgentRuntime
  startedAt: number
  text: string
  /** 该会话已发生的工具调用次数：报告里用它证明"真的在干活"。 */
  tools: number
}

/**
 * 会话 id 归一成可用的 caller 后缀（HTTP header 与 ref 前缀都只接受 ASCII）。
 *
 * 清洗后必须仍然唯一：否则「会话 一号」和「会话 二号」都会变成
 * builtin:session，两个内置会话共用授权与 ref 命名空间——比不隔离更糟。
 * 一旦发生截断或清空，就把原 id 的哈希接在后面。
 */
export function sessionCallerId(sessionId: string): string {
  const trimmed = sessionId.trim()
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40)
  const lossy = safe.length !== trimmed.length
  if (!lossy && safe) return `builtin:${safe}`
  const hash = createHash('sha1').update(trimmed).digest('hex').slice(0, 6)
  return `builtin:${safe || 'session'}-${hash}`
}

/** 保存时只用自己的会话替换盘上的同名项，其余原样保留。 */
export function mergeSession(
  disk: AgentSession[],
  incoming: AgentSession
): AgentSession[] {
  const rest = disk.filter((session) => session.id !== incoming.id)
  return trimSessionsForSave([incoming, ...rest])
}

function makeSession(): AgentSession {
  const now = Date.now()
  return {
    id: `s${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
    uiEvents: []
  }
}

export class BackgroundSessionRunner {
  private readonly running = new Map<string, RunningSession>()
  /** Retained after a session finishes so reports can quote real numbers. */
  private readonly counts = new Map<string, number>()
  private readonly options: SessionRunnerOptions

  constructor(options: SessionRunnerOptions) {
    this.options = options
  }

  /** 当前正在跑的后台会话 id（用于 UI 显示"N 个 agent 运行中"）。 */
  runningIds(): string[] {
    return [...this.running.keys()]
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /**
   * 在一个**独立 runtime** 里跑一个会话。已存在会话直接续跑；不存在则新建。
   * 返回该会话 id，调用方可以用 runningIds() 观察进度。
   */
  start(text: string, sessionId?: string): { ok: true; sessionId: string } | { ok: false; error: string } {
    const id = sessionId ?? this.options.makeSession?.().id ?? makeSession().id
    if (this.running.has(id)) return { ok: false, error: '该会话已经在运行' }

    const load = this.options.load ?? loadAgentSessions
    const save = this.options.save ?? saveAgentSessions
    const all = load()
    const existing = all.find((session) => session.id === id)
    const session: AgentSession = existing ?? { ...(this.options.makeSession?.() ?? makeSession()), id }

    const runtime = new AgentRuntime(
      this.options.makeExecutor(id) as never,
      this.options.getConfig as never,
      (event) => {
        if ((event as { kind?: string }).kind === 'tool') {
          this.counts.set(id, (this.counts.get(id) ?? 0) + 1)
        }
        const entry = this.running.get(id)
        if (entry) entry.tools = this.counts.get(id) ?? 0
        this.options.emit(id, event)
      },
      (this.options.chatFn ?? chatStream) as never,
      {
        getActiveTabId: this.options.getActiveTabId,
        // 把这次运行绑定到标签：协作锁按 caller 记账，后台会话也要有自己的绑定
        onRunStart: (tabId) => this.options.onStart?.(sessionCallerId(id), tabId),
        onRunEnd: () => this.options.onEnd?.(sessionCallerId(id)),
        // 每个后台实例只看见自己那一个会话
        load: () => [structuredClone(session)],
        loadWithMeta: () => ({ sessions: [structuredClone(session)], truncatedIds: new Set<string>() }),
        // 保存时合并：只替换自己的那一条
        save: (sessions: AgentSession[]) => {
          const mine = sessions.find((candidate) => candidate.id === id)
          if (!mine) return
          save(mergeSession(load(), mine))
        }
      }
    )

    this.running.set(id, { sessionId: id, runtime, startedAt: Date.now(), text, tools: 0 })
    // 不 await：调用方拿回 id 即刻返回，运行在后台继续
    void runtime
      .send(text)
      .catch((error: unknown) => {
        this.options.emit(id, {
          kind: 'error',
          text: `后台会话失败：${(error as Error)?.message ?? String(error)}`
        })
      })
      .finally(() => {
        this.running.delete(id)
        this.options.emit(id, { kind: 'done', text: '' })
      })

    return { ok: true, sessionId: id }
  }

  /** 急停所有后台会话（与主实例的急停分开，互不影响）。 */
  /** 每个会话的工具调用计数。 */
  toolCounts(): Record<string, number> {
    return Object.fromEntries(this.counts)
  }

  abortAll(): void {
    for (const entry of this.running.values()) {
      try {
        entry.runtime.abort()
      } catch {
        /* 单个失败不影响其它 */
      }
    }
  }
}
