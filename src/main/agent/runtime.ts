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
import { loadAgentSessions, saveAgentSessions, type AgentSession } from './store'
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
- 如果用户按 Esc 接管了浏览器（工具结果里会提示"用户已接管"），立即停止操作并简短告知用户，等待其指示。
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

export interface AgentDeps {
  /** Injectable for tests; defaults to the on-disk store. */
  load?: () => AgentSession[]
  save?: (sessions: AgentSession[]) => void
}

export class AgentRuntime {
  private sessions: AgentSession[]
  private currentId: string
  private messages: ChatMessage[]
  private uiLog: Record<string, unknown>[]
  private running = false
  private abortCtl: AbortController | null = null
  private seq = 0
  private nextId = 1
  private loadFn: () => AgentSession[]
  private saveFn: (sessions: AgentSession[]) => void
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  /** Messages sent while the agent was busy — auto-sent after the current run. */
  private queued: string[] = []

  constructor(
    private executeTool: ToolExecutor,
    private getConfig: () => AgentConfig,
    private emitRaw: (ev: Record<string, unknown>) => void,
    private chatFn: typeof chatStream = chatStream,
    deps?: AgentDeps
  ) {
    this.loadFn = deps?.load ?? loadAgentSessions
    this.saveFn = deps?.save ?? saveAgentSessions
    this.sessions = this.loadFn()
    if (this.sessions.length === 0) {
      this.sessions = [this.makeSession()]
    }
    this.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    const first = this.sessions[0]
    this.currentId = first.id
    this.messages = first.messages
    this.uiLog = first.uiEvents
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
    this.abortCtl?.abort()
  }

  /** Emergency stop: abort the run and drop every queued send. */
  abortForEmergency(): void {
    this.queued.length = 0
    this.abortCtl?.abort()
  }

  private emit(ev: AgentUiEvent): void {
    const full = {
      ...ev,
      sessionID: 'builtin',
      messageID: 'builtin',
      id: this.nextId++,
      ts: Date.now()
    }
    // collapse streaming updates: replace the previous event with the same
    // (kind, partID) instead of appending every delta snapshot (otherwise a
    // long task persists hundreds of copies of the same growing message)
    const pid = (full as { partID?: string }).partID
    let replaced = false
    if (pid && (full.kind === 'text' || full.kind === 'tool')) {
      for (let i = this.uiLog.length - 1; i >= 0; i--) {
        const e = this.uiLog[i] as { kind?: string; partID?: string }
        if (e.kind === full.kind && e.partID === pid) {
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

  async send(text: string): Promise<void> {
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
      return
    }
    const cfg = this.getConfig()
    if (!cfg.baseUrl || !cfg.model) {
      throw new Error('尚未配置模型（请在设置中填写 Base URL 和模型名）')
    }
    // resolve the runtime key: stored key, or imported from a local CLI login
    let apiKey = cfg.apiKey
    if (cfg.authType === 'import') {
      if (!cfg.authSource) {
        throw new Error('该模型配置选择了「导入凭据」，但未指定来源（codex / opencode）')
      }
      const r = resolveImportedKey(cfg.authSource, cfg.providerName)
      if (!r.ok || !r.apiKey) throw new Error(`导入凭据不可用：${r.error ?? '未知错误'}`)
      apiKey = r.apiKey
    }
    this.running = true
    this.abortCtl = new AbortController()
    // global watchdog: a run must never leave the panel stuck on "working"
    const watchdogMs = 15 * 60_000
    let watchdogFired = false
    const watchdog = setTimeout(() => {
      watchdogFired = true
      try {
        this.abortCtl?.abort()
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
    this.emit({ kind: 'text', role: 'user', partID: `u${++this.seq}`, text, done: true })
    const tools = buildOpenAiTools()
    try {
      const MAX_STEPS = 60
      let parseFailures = 0
      for (let step = 0; step < MAX_STEPS; step++) {
        if (this.abortCtl.signal.aborted) break
        const partID = `a${++this.seq}`
        let acc = ''
        const { text: assistantText, toolCalls } = await this.chatFn({
          protocol: cfg.protocol,
          baseUrl: cfg.baseUrl,
          apiKey,
          model: cfg.model,
          messages: this.messages,
          tools,
          signal: this.abortCtl.signal,
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
          if (this.abortCtl.signal.aborted) break
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
              throw new Error(
                '连续 3 次工具参数格式错误，已停止（本地小模型对工具调用格式的遵循较弱，建议重试或换用更强的模型）'
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
            const res = await this.executeTool(call.function.name, args)
            resultText = extractResultText(res)
            isErr = !!res.isError
          } catch (e) {
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
            output: resultText.slice(0, 2000)
          })
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: resultText.slice(0, 30000)
          })
        }
      }
    } catch (e) {
      const err = e as Error
      if (watchdogFired) {
        const msg = '任务运行超过 15 分钟，已自动中断（模型或工具可能卡住），面板状态已复位。'
        this.patchIncompleteToolCalls()
        this.messages.push({ role: 'assistant', content: `（${msg}）` })
        this.emit({ kind: 'session', status: 'idle', error: msg })
      } else if (err?.name === 'AbortError' || this.abortCtl.signal.aborted) {
        this.patchIncompleteToolCalls()
      } else {
        const msg = err?.message ?? String(e)
        this.messages.push({ role: 'assistant', content: `（模型调用失败：${msg}）` })
        this.emit({ kind: 'session', status: 'idle', error: msg })
      }
    } finally {
      clearTimeout(watchdog)
      this.running = false
      this.abortCtl = null
      this.emit({ kind: 'session', status: 'idle' })
      this.persistNow()
      // auto-send the next queued message (if any)
      const next = this.queued.shift()
      if (next) {
        setTimeout(() => {
          void this.send(next).catch(() => undefined)
        }, 60)
      }
    }
  }

  /** After an abort, keep the history valid for the next request. */
  private patchIncompleteToolCalls(): void {
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
        this.messages.push({ role: 'tool', tool_call_id: id, content: '（用户中止了操作）' })
      }
    }
  }
}
