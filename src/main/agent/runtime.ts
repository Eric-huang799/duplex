/**
 * Built-in agent mode: an in-app agent loop that drives the browser through
 * the same ToolExecutor as the MCP path (identical visuals/behavior), talking
 * to any OpenAI-compatible chat API. Coexists with the opencode mode.
 */
import type { AgentConfig } from '../settings'
import { chatStream, parseToolArguments, type ChatMessage } from './llm'
import { resolveImportedKey } from './auth-import'
import { skillsPromptSection } from './skills'
import { buildOpenAiTools } from './tools-schema'
import { loadAgentSessionsWithMeta, saveAgentSessions, type AgentSession } from './store'
import type { ToolExecutor, ToolResult } from '../tool-handlers'

export interface AgentUiEvent {
  kind: 'text' | 'tool' | 'session'
  partID?: string
  role?: 'user' | 'assistant'
  text?: string
  done?: boolean
  tool?: string
  callID?: string
  status?: string
  input?: unknown
  output?: string
  error?: string
}

const SYSTEM_PROMPT = `你是 Duplex 浏览器的内置操作 agent。你可以直接读写并操作用户当前浏览器里的页面。

工作规则：
- 用 snapshot 查看页面结构（这是你的主要“眼睛”）：它返回紧凑的 DOM 大纲，可交互元素带 [eN] ref。
- 用 click/type/hover/dblclick/drag 等工具操作元素时，target 可以是 ref（如 "e12"）或 CSS 选择器。ref 在页面导航后失效，需要重新 snapshot。
- 需要更多细节时用 query（查选择器）或 get_html（读源码）；页面动态内容多时可用 wait 等待元素/文本出现。
- 需要搜索时用 search 工具；已知网址用 navigate。
- 页面加载慢是正常的；需要时用 wait。
- 每完成一个关键步骤后再决定下一步，不要臆测页面内容——先读（snapshot）再操作。
- 完成任务后，用简洁的中文给出最终回答（说明你做了什么、发现了什么）。不要在回答里粘贴大段 HTML。
- 如果用户按下了急停快捷键接管了浏览器（工具结果里会提示"用户已接管"），立即停止操作并简短告知用户，等待其指示。
- 涉及提交表单、发送消息、下单等敏感操作前，如果用户没有明确要求，先说明你将要做什么。`

/** Base prompt plus the currently enabled skills (progressive disclosure:
 *  only name + description here; full instructions come from read_skill). */
function buildSystemPrompt(): string {
  const base = SYSTEM_PROMPT
  try {
    const skills = skillsPromptSection()
    if (!skills) return base
    return `${base}\n\n可用的 Skills（当任务与某个 skill 匹配时，先用 read_skill 读取完整说明，再按说明执行；skill 附带的脚本用 run_skill_script 运行；需要写脚本/文件时用 write_file，需要运行命令时用 run_command——脚本与命令执行前都会请求用户确认）：\n${skills}`
  } catch {
    return base
  }
}

function extractResultText(res: ToolResult): string {
  const parts: string[] = []
  for (const c of res.content) {
    if (c.type === 'text') parts.push(c.text)
    else if (c.type === 'image') {
      parts.push('[已截图：当前为纯文本模式，图片未包含；请优先用 snapshot 读取页面结构]')
    }
  }
  return parts.join('\n') || '(无输出)'
}

/** Clip a tool result for display/history and say how much was dropped. */
function truncateWithMarker(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…（已截断：完整 ${s.length} 字符）`
}

/** Short, user-facing attribution for a failed LLM request (raw text goes to the log). */
function describeLlmError(e: unknown, idleTimeoutMs: number): string {
  const msg = (e as Error)?.message ?? String(e ?? '')
  if (/超时/.test(msg)) {
    return `模型响应超时（${Math.round(idleTimeoutMs / 1000)} 秒无数据），推理模型建议在模型配置中调大空闲超时`
  }
  const status = /(?:模型接口返回|HTTP)\s*(\d{3})/.exec(msg)?.[1]
  if (status === '401' || status === '403') {
    return 'API Key 无效或无权访问，请在模型配置中检查'
  }
  if (status === '404') return '接口地址或模型名不存在'
  if (status === '429') return '请求被限流，请稍后重试'
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|连接/i.test(msg)) {
    return '网络连接失败'
  }
  return `模型调用失败：${msg.slice(0, 120)}`
}

/** Marker thrown when a run is stopped while a tool call is still awaiting. */
class AbortedOperationError extends Error {
  constructor() {
    super('任务已停止')
    this.name = 'AbortError'
  }
}

/** Thrown after 3 consecutive tool-argument parse failures (message is already user-facing). */
class ToolArgsAbortError extends Error {}

export interface AgentDeps {
  /** Injectable for tests; defaults to the on-disk store. */
  load?: () => AgentSession[]
  /** Like load, but also reports which sessions lost history to the storage caps. */
  loadWithMeta?: () => { sessions: AgentSession[]; truncatedIds: Set<string> }
  save?: (sessions: AgentSession[]) => void
}

/** Constant partID so the one-time truncation notice is never duplicated. */
const TRUNCATION_NOTICE_PART_ID = 'sys-history-truncated'

export class AgentRuntime {
  private sessions: AgentSession[]
  private currentId: string
  private messages: ChatMessage[]
  private uiLog: Record<string, unknown>[]
  private running = false
  private abortCtl: AbortController | null = null
  private seq = 0
  private nextId = 1
  /** Sessions whose loaded history was cut by the store caps (fires one notice each). */
  private truncatedIds: Set<string>
  private saveFn: (sessions: AgentSession[]) => void
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  /** Pending 60ms-later auto-send of the next queued message (cancelled by abort). */
  private autoSendTimer: ReturnType<typeof setTimeout> | null = null
  /** Messages sent while the agent was busy — auto-sent after the current run. */
  private queued: string[] = []
  /** Set when abort()/abortForEmergency() was called; a stopped run never resends. */
  private stopRequested = false

  constructor(
    private executeTool: ToolExecutor,
    private getConfig: () => AgentConfig,
    private emitRaw: (ev: Record<string, unknown>) => void,
    private chatFn: typeof chatStream = chatStream,
    deps?: AgentDeps
  ) {
    this.saveFn = deps?.save ?? saveAgentSessions
    const loaded = deps?.loadWithMeta
      ? deps.loadWithMeta()
      : deps?.load
        ? { sessions: deps.load(), truncatedIds: new Set<string>() }
        : loadAgentSessionsWithMeta()
    this.sessions = loaded.sessions
    this.truncatedIds = loaded.truncatedIds
    if (this.sessions.length === 0) {
      this.sessions = [this.makeSession()]
    }
    this.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    const first = this.sessions[0]
    this.currentId = first.id
    this.messages = first.messages
    this.uiLog = first.uiEvents
    // restored events keep their ids; continue numbering after them so React
    // keys never collide between the restored log and this run's new events
    this.bumpNextId()
    this.noticeTruncation(first)
  }

  /** Continue id numbering after every restored event log. */
  private bumpNextId(): void {
    let max = 0
    for (const s of this.sessions) {
      for (const e of s.uiEvents) {
        const id = (e as { id?: unknown }).id
        if (typeof id === 'number' && Number.isFinite(id) && id > max) max = id
      }
    }
    this.nextId = max + 1
  }

  /**
   * One-time separator above the oldest retained message when the store cut
   * this session's history at load time. Plain assistant text (visible in the
   * agent panel, unlike internal session events) and a constant partID keeps it
   * from ever being shown twice.
   */
  private noticeTruncation(session: AgentSession): void {
    if (!this.truncatedIds.has(session.id)) return
    const already = session.uiEvents.some(
      (e) => e.kind === 'text' && e.partID === TRUNCATION_NOTICE_PART_ID
    )
    if (already) return
    const ev = {
      kind: 'text',
      role: 'assistant',
      partID: TRUNCATION_NOTICE_PART_ID,
      text: '（更早的消息已因存储上限不再保留）',
      done: true,
      sessionID: 'builtin',
      messageID: 'builtin',
      id: this.nextId++,
      ts: Date.now()
    }
    session.uiEvents.unshift(ev)
    try {
      this.emitRaw(ev)
    } catch {
      /* the window may be gone; the event is still in the restored log */
    }
    this.schedulePersist()
  }

  private makeSession(): AgentSession {
    return {
      id: `as${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ role: 'system', content: SYSTEM_PROMPT }],
      uiEvents: []
    }
  }

  private currentSession(): AgentSession | null {
    return this.sessions.find((s) => s.id === this.currentId) ?? null
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, 800)
  }

  private persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    const cur = this.currentSession()
    if (cur) cur.updatedAt = Date.now()
    try {
      this.saveFn(this.sessions)
    } catch {
      /* persistence must never crash the agent */
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  get currentSessionId(): string {
    return this.currentId
  }

  listSessions(): Array<{ id: string; title: string; updatedAt: number; current: boolean }> {
    return this.sessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        current: s.id === this.currentId
      }))
  }

  /** Start a fresh conversation (keeps previous ones in the history list). */
  newSession(): { ok: boolean; error?: string } {
    if (this.running) return { ok: false, error: '正在运行中，请先停止' }
    const s = this.makeSession()
    this.sessions.unshift(s)
    this.activateSession(s)
    return { ok: true }
  }

  switchSession(id: string): { ok: boolean; error?: string } {
    if (this.running) return { ok: false, error: '正在运行中，请先停止' }
    const s = this.sessions.find((x) => x.id === id)
    if (!s) return { ok: false, error: '会话不存在' }
    this.activateSession(s)
    return { ok: true }
  }

  deleteSession(id: string): { ok: boolean; error?: string } {
    if (this.running) return { ok: false, error: '正在运行中，请先停止' }
    const idx = this.sessions.findIndex((x) => x.id === id)
    if (idx < 0) return { ok: false, error: '会话不存在' }
    this.sessions.splice(idx, 1)
    if (this.currentId === id) {
      if (this.sessions.length === 0) this.sessions.push(this.makeSession())
      this.activateSession(this.sessions[0])
    } else {
      this.persistNow()
    }
    return { ok: true }
  }

  private activateSession(s: AgentSession): void {
    this.currentId = s.id
    this.messages = s.messages
    this.uiLog = s.uiEvents
    this.noticeTruncation(s)
    const ev = {
      kind: 'session',
      status: 'idle',
      info: 'switched',
      title: s.title,
      sessionID: 'builtin',
      messageID: 'builtin',
      id: this.nextId++,
      ts: Date.now()
    }
    this.uiLog.push(ev)
    this.emitRaw(ev)
    this.persistNow()
  }

  /** UI event log for panel restore. */
  events(): Record<string, unknown>[] {
    return this.uiLog.slice()
  }

  /** Legacy alias: start a fresh session. */
  reset(): void {
    this.newSession()
  }

  abort(): void {
    const hadPendingAutoSend = this.autoSendTimer !== null
    if (this.autoSendTimer) {
      clearTimeout(this.autoSendTimer)
      this.autoSendTimer = null
    }
    const dropped = this.queued.length
    this.stopRequested = true
    this.queued.length = 0
    this.abortCtl?.abort()
    if (this.running || hadPendingAutoSend) {
      this.emit({
        kind: 'text',
        role: 'assistant',
        partID: `stop${++this.seq}`,
        text: `已停止；已取消 ${dropped} 条排队消息`,
        done: true
      })
    }
  }

  /** Emergency stop: abort the run and drop every queued send. */
  abortForEmergency(): void {
    if (this.autoSendTimer) {
      clearTimeout(this.autoSendTimer)
      this.autoSendTimer = null
    }
    this.stopRequested = true
    this.queued.length = 0
    this.abortCtl?.abort()
  }

  /**
   * A human page annotation routed to the built-in agent (A5 calls this).
   * With a question it starts a run; without one it only records the text as
   * a user message so the next run still has the annotation in context.
   */
  injectAnnotation(
    text: string,
    meta: {
      question?: string
      summary: string
      url: string
      annotationId: string
      tool: 'rect' | 'circle' | 'arrow' | 'point'
      elementCount: number
    }
  ): void {
    this.pushUiEvent({
      kind: 'annotation',
      source: 'agent',
      annotationId: meta.annotationId,
      text,
      question: meta.question,
      tool: meta.tool,
      url: meta.url,
      summary: meta.summary,
      elementCount: meta.elementCount,
      id: this.nextId++,
      ts: Date.now()
    })
    if (meta.question) {
      // the annotation text carries the question — run it as a normal user turn
      void this.send(text).catch((e) => {
        console.error('[agent] annotation run failed to start:', e)
        this.emit({ kind: 'session', status: 'error', error: (e as Error)?.message ?? String(e) })
      })
      return
    }
    this.messages.push({ role: 'user', content: text })
    this.emit({ kind: 'text', role: 'user', partID: `u${++this.seq}`, text, done: true })
  }

  private emit(ev: AgentUiEvent): void {
    this.pushUiEvent({
      ...ev,
      sessionID: 'builtin',
      messageID: 'builtin',
      id: this.nextId++,
      ts: Date.now()
    })
  }

  /** Append an already-shaped event (text/tool/session/annotation) to the log. */
  private pushUiEvent(full: Record<string, unknown>): void {
    // collapse streaming updates: replace the previous event with the same
    // (kind, partID) instead of appending every delta snapshot (otherwise a
    // long task persists hundreds of copies of the same growing message)
    const pid = full.partID as string | undefined
    const kind = full.kind as string | undefined
    let replaced = false
    if (pid && (kind === 'text' || kind === 'tool')) {
      for (let i = this.uiLog.length - 1; i >= 0; i--) {
        const e = this.uiLog[i] as { kind?: string; partID?: string }
        if (e.kind === kind && e.partID === pid) {
          this.uiLog[i] = full
          replaced = true
          break
        }
      }
    }
    if (!replaced) this.uiLog.push(full)
    if (this.uiLog.length > 600) this.uiLog.splice(0, this.uiLog.length - 600)
    this.schedulePersist()
    try {
      this.emitRaw(full)
    } catch {
      /* the window may be gone; never let emitting break the agent loop */
    }
  }

  /** A send that cannot start must keep the user's input visible in the panel. */
  private failSend(text: string, error: string, echo = true): { ok: false; error: string } {
    this.messages.push({ role: 'user', content: text })
    if (echo) this.emit({ kind: 'text', role: 'user', partID: `u${++this.seq}`, text, done: true })
    this.emit({ kind: 'session', status: 'error', error })
    return { ok: false, error }
  }

  /** Race a tool call against the run signal so abort/watchdog always release the panel. */
  private awaitWithAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      p.catch(() => undefined)
      return Promise.reject(new AbortedOperationError())
    }
    let onAbort: (() => void) | null = null
    const stopped = new Promise<T>((_resolve, reject) => {
      onAbort = () => reject(new AbortedOperationError())
      signal.addEventListener('abort', onAbort, { once: true })
    })
    // the abandoned side of the race must not surface as an unhandled rejection
    p.catch(() => undefined)
    return Promise.race([p, stopped]).finally(() => {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    })
  }

  /**
   * Run one user turn. `opts.fromQueue` is set by the auto-send pump: the
   * queued bubble was already shown (with its "已排队" hint) when the message
   * arrived, so the resend must not echo it to the UI again. History is only
   * written here (never at queue time) so a queued message cannot leak into the
   * still-running turn's context.
   */
  async send(
    text: string,
    opts?: { fromQueue?: boolean }
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.running) {
      // busy: queue the message and let the user see it — it will be sent
      // automatically when the current run finishes
      this.queued.push(text)
      this.emit({
        kind: 'text',
        role: 'user',
        partID: `q${++this.seq}`,
        text: `${text}\n\n（已排队：将在当前任务完成后自动发送）`,
        done: true
      })
      return { ok: true }
    }
    const echo = !opts?.fromQueue
    const cfg = this.getConfig()
    if (!cfg.baseUrl || !cfg.model) {
      return this.failSend(text, '未配置模型：请在设置中填写 Base URL 和模型名', echo)
    }
    // resolve the runtime key: stored key, or imported from a local CLI login
    let apiKey = cfg.apiKey
    if (cfg.authType === 'import') {
      if (!cfg.authSource) {
        return this.failSend(
          text,
          '未配置模型：该配置选择了「导入凭据」，但未指定来源（codex / opencode）',
          echo
        )
      }
      const r = resolveImportedKey(cfg.authSource, cfg.providerName)
      if (!r.ok || !r.apiKey) {
        return this.failSend(text, `导入凭据不可用：${r.error ?? '未知错误'}`, echo)
      }
      apiKey = r.apiKey
    }
    // A1b adds idleTimeoutMs to the provider config; read it safely until then
    const idleTimeoutMs =
      (cfg as typeof cfg & { idleTimeoutMs?: number }).idleTimeoutMs ?? 120_000
    this.running = true
    this.stopRequested = false
    const ctl = new AbortController()
    this.abortCtl = ctl
    // global watchdog: a run must never leave the panel stuck on "working"
    const watchdogMs = 15 * 60_000
    let watchdogFired = false
    const watchdog = setTimeout(() => {
      watchdogFired = true
      try {
        ctl.abort()
      } catch {
        /* ignore */
      }
    }, watchdogMs)
    this.emit({ kind: 'session', status: 'busy' })
    // name the conversation after its first user message
    const cur = this.currentSession()
    if (cur && (cur.title === '新对话' || !cur.title)) {
      const t = text.replace(/\s+/g, ' ').trim().slice(0, 30)
      if (t) cur.title = t
    }
    // refresh the system prompt so newly enabled/installed skills are visible
    if (this.messages[0]?.role === 'system') {
      this.messages[0] = { role: 'system', content: buildSystemPrompt() }
    }
    this.messages.push({ role: 'user', content: text })
    if (echo) {
      this.emit({ kind: 'text', role: 'user', partID: `u${++this.seq}`, text, done: true })
    }
    let sessionError = false
    try {
      const tools = buildOpenAiTools()
      const MAX_STEPS = 60
      let parseFailures = 0
      let reachedStepLimit = false
      for (let step = 0; step < MAX_STEPS; step++) {
        if (ctl.signal.aborted) break
        const partID = `a${++this.seq}`
        let acc = ''
        const { text: assistantText, toolCalls } = await this.chatFn({
          protocol: cfg.protocol,
          baseUrl: cfg.baseUrl,
          apiKey,
          model: cfg.model,
          messages: this.messages,
          tools,
          signal: ctl.signal,
          idleTimeoutMs,
          authType: cfg.authType,
          authSource: cfg.authSource,
          allowCustomHost: cfg.allowCustomHost,
          onTextDelta: (d) => {
            acc += d
            this.emit({ kind: 'text', role: 'assistant', partID, text: acc, done: false })
          }
        })
        if (assistantText && assistantText !== acc) {
          acc = assistantText
        }
        if (acc) this.emit({ kind: 'text', role: 'assistant', partID, text: acc, done: true })

        if (toolCalls.length === 0) {
          if (!assistantText || !assistantText.trim()) {
            // the model ended the turn with neither text nor tool calls —
            // surface it instead of silently stopping (looks like a hang)
            this.emit({
              kind: 'text',
              role: 'assistant',
              partID,
              text: '（模型返回了空响应，本次任务已结束。可以重试或换个模型。）',
              done: true
            })
          }
          this.messages.push({ role: 'assistant', content: assistantText || '' })
          break
        }

        this.messages.push({
          role: 'assistant',
          content: assistantText || null,
          tool_calls: toolCalls
        })
        for (const call of toolCalls) {
          if (ctl.signal.aborted) break
          const tPart = `t${++this.seq}`
          const parsed = parseToolArguments(call.function.arguments)
          if (!parsed.ok) {
            // weak local models produce almost-JSON: tell the model explicitly
            // so it can correct itself instead of silently executing with {}
            parseFailures++
            this.emit({
              kind: 'tool',
              partID: tPart,
              tool: call.function.name,
              callID: call.id,
              status: 'error',
              output: parsed.error
            })
            this.messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: `参数解析失败：${parsed.error}。请重新调用该工具，arguments 必须是合法的 JSON 对象。`
            })
            if (parseFailures >= 3) {
              throw new ToolArgsAbortError(
                parsed.reason === 'truncated'
                  ? '模型响应被截断导致工具参数不完整'
                  : '模型输出格式不符合工具调用规范'
              )
            }
            continue
          }
          parseFailures = 0
          const args = parsed.value
          this.emit({
            kind: 'tool',
            partID: tPart,
            tool: call.function.name,
            callID: call.id,
            status: 'running',
            input: args
          })
          let resultText = ''
          let isErr = false
          try {
            const res = await this.awaitWithAbort(
              this.executeTool(call.function.name, args),
              ctl.signal
            )
            resultText = extractResultText(res)
            isErr = !!res.isError
          } catch (e) {
            const stopped =
              e instanceof AbortedOperationError ||
              (e as Error)?.name === 'AbortError' ||
              ctl.signal.aborted
            if (stopped) {
              // the run was stopped (user abort / watchdog): do not write an
              // error into the history — patchIncompleteToolCalls fills it
              this.emit({
                kind: 'tool',
                partID: tPart,
                tool: call.function.name,
                callID: call.id,
                status: 'error',
                input: args,
                output: '（操作已停止）'
              })
              throw new AbortedOperationError()
            }
            resultText = `工具执行失败: ${(e as Error)?.message ?? String(e)}`
            isErr = true
          }
          this.emit({
            kind: 'tool',
            partID: tPart,
            tool: call.function.name,
            callID: call.id,
            status: isErr ? 'error' : 'completed',
            input: args,
            output: truncateWithMarker(resultText, 2000)
          })
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: truncateWithMarker(resultText, 30000)
          })
        }
        if (step === MAX_STEPS - 1) reachedStepLimit = true
      }
      if (reachedStepLimit && !ctl.signal.aborted) {
        const msg = '已达到单轮 60 步上限，任务可能尚未完成；可继续发消息让 AI 接着做'
        this.messages.push({ role: 'assistant', content: msg })
        this.emit({
          kind: 'text',
          role: 'assistant',
          partID: `a${++this.seq}`,
          text: msg,
          done: true
        })
      }
    } catch (e) {
      const err = e as Error
      if (watchdogFired) {
        const msg = '任务超时：运行超过 15 分钟，已自动中断（模型或工具可能卡住），面板状态已复位。'
        this.patchIncompleteToolCalls('（操作超时已中止）')
        this.messages.push({ role: 'assistant', content: `（${msg}）` })
        this.emit({ kind: 'session', status: 'error', error: msg })
        sessionError = true
      } else if (err?.name === 'AbortError' || ctl.signal.aborted) {
        this.patchIncompleteToolCalls()
      } else if (e instanceof ToolArgsAbortError) {
        // already a user-facing explanation — emit as-is
        this.emit({ kind: 'session', status: 'error', error: err.message })
        sessionError = true
      } else {
        // never store the raw API error as a chat message; log it and emit a
        // short Chinese attribution instead
        console.error('[agent] run failed:', e)
        const msg = describeLlmError(e, idleTimeoutMs)
        this.emit({ kind: 'session', status: 'error', error: msg })
        sessionError = true
      }
    } finally {
      clearTimeout(watchdog)
      this.running = false
      this.abortCtl = null
      // a session error event is the terminal event for the panel (it also
      // clears the busy state); an extra idle would mask the error
      if (!sessionError) this.emit({ kind: 'session', status: 'idle' })
      this.persistNow()
      if (this.stopRequested) {
        // a stopped run never auto-resends, including messages queued in the
        // small window between abort() and this finally
        this.queued.length = 0
      } else if (this.queued.length > 0) {
        // auto-send the next queued message (if any)
        this.autoSendTimer = setTimeout(() => {
          this.autoSendTimer = null
          if (this.stopRequested) {
            this.queued.length = 0
            return
          }
          // a manual run started in the meantime; its finally pumps the queue
          if (this.running) return
          const next = this.queued.shift()
          if (next) {
            void this.send(next, { fromQueue: true }).catch((e) => {
              console.error('[agent] queued message failed to send:', e)
              this.emit({
                kind: 'session',
                status: 'error',
                error: (e as Error)?.message ?? String(e)
              })
            })
          }
        }, 60)
      }
    }
    return { ok: true }
  }

  /** After an abort/timeout, keep the history valid for the next request. */
  private patchIncompleteToolCalls(reason = '（用户中止了操作）'): void {
    let idx = -1
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        idx = i
        break
      }
      if (m.role === 'tool') continue
      break
    }
    if (idx < 0) return
    const callIds = this.messages[idx].tool_calls!.map((c) => c.id)
    const resolved = new Set(
      this.messages
        .slice(idx + 1)
        .filter((m) => m.role === 'tool')
        .map((m) => m.tool_call_id)
    )
    for (const id of callIds) {
      if (!resolved.has(id)) {
        this.messages.push({ role: 'tool', tool_call_id: id, content: reason })
      }
    }
  }
}
