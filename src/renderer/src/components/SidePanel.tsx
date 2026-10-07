import { useEffect, useRef, useState } from 'react'
import type {
  MirrorAnnotationEvent,
  MirrorEvent,
  MirrorSessionInfoEvent
} from '../../../shared/protocol'
import type { LocalMessage } from '../App'
import { ToolCard } from './ToolCard'
import { PermissionCard, type PermissionRequest } from './PermissionCard'
import { MarkdownProse } from './Markdown'
import { ProvidersPanel } from './ProvidersPanel'
import { SkillsPanel } from './SkillsPanel'
import { ExternalToolPanel, type AgentToolInfo } from './ExternalToolPanel'

export type PanelMode = 'opencode' | 'agent' | 'external'

interface Props {
  width: number
  events: MirrorEvent[]
  localMsgs: LocalMessage[]
  onSend: (text: string) => void
  onCollapse: () => void
  mode: PanelMode
  onModeChange: (m: PanelMode) => void
  agentEvents: MirrorEvent[]
  externalTool: string
  onExternalToolChange: (id: string) => void
  confirms: PermissionRequest[]
  onConfirmRespond: (id: number, ok: boolean) => void
  onAgentSessionDeleted?: () => void
  initialShowProviders?: boolean
}

function timeAgo(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

function AnnotationNotice({ ev }: { ev: MirrorAnnotationEvent }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="annot-card">
      <div className="annot-head" onClick={() => setOpen((v) => !v)}>
        <span className="annot-icon">✎</span>
        <span className="annot-summary">{ev.summary}</span>
        <span className="annot-toggle">{open ? '▾' : '▸'}</span>
      </div>
      {ev.question && <div className="annot-question">「{ev.question}」</div>}
      {open && <pre className="annot-full">{ev.text}</pre>}
    </div>
  )
}

function MirrorItem({ ev, pendingToolId }: { ev: MirrorEvent; pendingToolId?: number | null }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)

  if (ev.kind === 'annotation') {
    return <AnnotationNotice ev={ev} />
  }
  if (ev.kind === 'text') {
    const isUser = ev.role === 'user'
    return (
      <div className={`msg ${isUser ? 'user' : 'assistant'}`}>
        {isUser ? <div className="msg-body">{ev.text}</div> : <MarkdownProse text={ev.text} />}
      </div>
    )
  }
  if (ev.kind === 'reasoning') {
    return (
      <details className="reasoning">
        <summary>思考过程</summary>
        <pre>{ev.text}</pre>
      </details>
    )
  }
  if (ev.kind === 'tool') {
    return (
      <ToolCard
        ev={ev}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        waiting={pendingToolId != null && ev.id === pendingToolId && ev.status === 'running'}
      />
    )
  }
  if (ev.kind === 'session') {
    if (ev.status === 'error') {
      return <div className="session-line err">会话错误：{ev.error ?? '未知错误'}</div>
    }
    return <div className="session-line">— 本轮结束 —</div>
  }
  return null
}

export function SidePanel({
  width,
  events,
  localMsgs,
  onSend,
  onCollapse,
  mode,
  onModeChange,
  agentEvents,
  externalTool,
  onExternalToolChange,
  confirms,
  onConfirmRespond,
  onAgentSessionDeleted,
  initialShowProviders
}: Props): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [sessionMenu, setSessionMenu] = useState(false)
  const [showProviders, setShowProviders] = useState(initialShowProviders ?? false)
  const [showSkills, setShowSkills] = useState(false)
  const [tools, setTools] = useState<AgentToolInfo[]>([])
  const [externalErr, setExternalErr] = useState('')
  const [externalPending, setExternalPending] = useState(false)
  const [externalOpened, setExternalOpened] = useState<{ id: string; title: string } | null>(null)
  const [creatingSession, setCreatingSession] = useState(false)
  const [agentChildren, setAgentChildren] = useState(0)
  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addDir, setAddDir] = useState('')
  const [addCmd, setAddCmd] = useState('')
  const [addErr, setAddErr] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  const refreshTools = async (): Promise<void> => {
    try {
      const list = (await window.cobrowse.agentsList()) as AgentToolInfo[]
      setTools(Array.isArray(list) ? list : [])
      // if the selected external tool disappeared, fall back to opencode
      if (
        mode === 'external' &&
        externalTool &&
        Array.isArray(list) &&
        !list.some((t) => t.id === externalTool)
      ) {
        onModeChange('opencode')
      }
    } catch {
      /* ignore */
    }
  }

  const addToolFlow = (): void => {
    setAddName('')
    setAddDir('')
    setAddCmd('')
    setAddErr('')
    setAddOpen(true)
  }

  const submitAddTool = async (): Promise<void> => {
    const name = addName.trim()
    const dir = addDir.trim()
    if (!name || !dir) return
    setAddBusy(true)
    setAddErr('')
    const r = await window.cobrowse.agentsAdd(name, dir, addCmd.trim() || undefined)
    setAddBusy(false)
    if (!r.ok) {
      setAddErr(r.error ?? '添加失败')
      return
    }
    setAddOpen(false)
    await refreshTools()
    if (r.id) onExternalToolChange(r.id)
  }

  useEffect(() => {
    void refreshTools()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Composer grows with its content (1–2 rows up to ~8 rows) without jumping.
  useEffect(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    const maxHeight = 164
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [draft])

  useEffect(() => {
    const off = window.cobrowse.onAgentsChildren((n) => setAgentChildren(n))
    return off
  }, [])
  const [agentReady, setAgentReady] = useState(false)
  const [agentError, setAgentError] = useState('')
  const [agentSessionMenu, setAgentSessionMenu] = useState(false)
  const [agentSessions, setAgentSessions] = useState<
    Array<{ id: string; title: string; updatedAt: number; current: boolean }>
  >([])
  const [confirmAgentDel, setConfirmAgentDel] = useState<{
    id: string
    stage: number
  } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Esc closes the session pickers and the add-tool dialog.
  useEffect(() => {
    if (!sessionMenu && !agentSessionMenu && !addOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (addOpen) {
        setAddOpen(false)
        return
      }
      setSessionMenu(false)
      setAgentSessionMenu(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionMenu, agentSessionMenu, addOpen])

  const isAgent = mode === 'agent'

  const refreshAgentReady = (): void => {
    void window.cobrowse.agentProviders().then((s) => setAgentReady(s.providers.length > 0))
  }

  const toggleAgentSessions = (): void => {
    const next = !agentSessionMenu
    setAgentSessionMenu(next)
    if (next) void window.cobrowse.agentSessions().then(setAgentSessions)
  }

  const switchAgentSession = (id: string): void => {
    void window.cobrowse.agentSwitchSession(id).then(() => setAgentSessionMenu(false))
  }

  const deleteAgentSession = (id: string): void => {
    if (!confirmAgentDel || confirmAgentDel.id !== id) {
      setConfirmAgentDel({ id, stage: 1 })
      setTimeout(() => setConfirmAgentDel((c) => (c && c.id === id ? null : c)), 4000)
      return
    }
    if (confirmAgentDel.stage === 1) {
      setConfirmAgentDel({ id, stage: 2 })
      return
    }
    setConfirmAgentDel(null)
    const wasCurrent = agentSessions.find((s) => s.id === id)?.current === true
    void window.cobrowse.agentDeleteSession(id).then((r) => {
      if (!r.ok) {
        if (r.error) setAgentError(r.error)
        return
      }
      void window.cobrowse.agentSessions().then(setAgentSessions)
      // only reset the visible transcript when the CURRENT session was deleted
      if (wasCurrent) onAgentSessionDeleted?.()
    })
  }

  const newAgentSession = (): void => {
    void window.cobrowse.agentNewSession()
    setAgentSessionMenu(false)
  }

  useEffect(() => {
    if (isAgent) refreshAgentReady()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAgent])

  const displayEvents = isAgent ? agentEvents : events

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [displayEvents, localMsgs, autoScroll])

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
  }

  const extToolInfo = mode === 'external' ? tools.find((t) => t.id === externalTool) : undefined
  const extKind = extToolInfo?.kind
  const externalCanStart =
    !!extToolInfo?.available &&
    (extKind === 'codex' ||
      extKind === 'claude' ||
      extKind === 'gemini' ||
      extKind === 'qwen' ||
      (extKind === 'custom' && !!extToolInfo?.command))
  /** Codex / Claude Code sessions can be continued from the panel. */
  const extCanReply = extKind === 'codex' || extKind === 'claude'
  const extReplyReady = extCanReply && !!externalOpened

  const send = (): void => {
    const t = draft.trim()
    if (!t) return
    if (mode === 'external') {
      if (extReplyReady) {
        if (externalPending) return
        setExternalErr('')
        setExternalPending(true)
        void window.cobrowse.agentsSessionSend(externalTool, t).then((r) => {
          setExternalPending(false)
          if (!r.ok) {
            setExternalErr(r.error ?? '发送失败')
            return
          }
          setDraft((d) => (d.trim() === t ? '' : d))
        })
        return
      }
      if (!externalCanStart || externalPending) return
      setExternalErr('')
      setExternalPending(true)
      void window.cobrowse.agentsStartSession(externalTool, t).then((r) => {
        setExternalPending(false)
        if (!r.ok) {
          setExternalErr(r.error ?? '启动失败')
          return
        }
        setDraft((d) => (d.trim() === t ? '' : d))
      })
      return
    }
    if (isAgent) {
      setAgentError('')
      void window.cobrowse.agentSend(t).then((res) => {
        if (res.ok) {
          setDraft((d) => (d.trim() === t ? '' : d))
          return
        }
        if (res.error) setAgentError(res.error)
      })
      return
    }
    setDraft('')
    onSend(t)
  }

  // ------- opencode-mode derived state -------
  // Busy = the most recent state-defining event (tool status or session
  // status). Later events override older stuck states — e.g. a tool whose
  // "completed" event was dropped while the panel was mirroring an external
  // tool would otherwise keep this permanently "working".
  let busy = false
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.kind === 'tool') {
      busy = e.status === 'running' || e.status === 'pending'
      break
    }
    if (e.kind === 'session') {
      busy = e.status === 'busy'
      break
    }
  }
  const lastTs = events.length ? events[events.length - 1].ts : 0
  const connected = Date.now() - lastTs < 120_000

  const annotationTexts = new Set(
    events
      .filter((e): e is MirrorAnnotationEvent => e.kind === 'annotation')
      .map((e) => e.text)
  )
  const visibleEvents = events.filter(
    (e) =>
      e.kind !== 'session-info' &&
      !(e.kind === 'text' && e.role === 'user' && annotationTexts.has(e.text))
  )

  let sessionInfo: MirrorSessionInfoEvent | undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.kind === 'session-info') {
      sessionInfo = e
      break
    }
  }

  // once the newly created session shows up, clear the "creating" state
  useEffect(() => {
    if (creatingSession && sessionInfo?.activeSessionID) setCreatingSession(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatingSession, sessionInfo?.activeSessionID])

  const toggleSessionMenu = (): void => {
    const next = !sessionMenu
    setSessionMenu(next)
    if (next) void window.cobrowse.sessionCommand({ action: 'list' })
  }

  const pickSession = (id: string | null, title?: string): void => {
    void window.cobrowse.sessionCommand({ action: 'select', sessionID: id, title })
    setSessionMenu(false)
  }

  const createSession = (): void => {
    if (creatingSession) return
    setCreatingSession(true)
    setSessionMenu(false)
    void window.cobrowse.sessionCommand({ action: 'create' })
    // safety net: never leave the pending state stuck
    window.setTimeout(() => setCreatingSession(false), 8000)
  }

  // ------- agent-mode derived state -------
  let agentSessionState: 'idle' | 'busy' = 'idle'
  let agentSessionError = ''
  for (let i = agentEvents.length - 1; i >= 0; i--) {
    const e = agentEvents[i]
    if (e.kind === 'session') {
      agentSessionState = e.status === 'busy' ? 'busy' : 'idle'
      if (e.status === 'error') agentSessionError = e.error ?? ''
      break
    }
  }
  const agentConfigured = agentReady
  const agentVisible = agentEvents.filter((e) => e.kind !== 'session')
  // While a permission request is pending, only the most recent running tool
  // card with the same tool name shows "waiting for your permission"; when the
  // same tool runs concurrently the older cards keep their own state.
  const pendingConfirmTool = confirms.find((c) => c.state === 'pending')?.tool
  let pendingToolId: number | null = null
  if (pendingConfirmTool) {
    for (let i = displayEvents.length - 1; i >= 0; i--) {
      const e = displayEvents[i]
      if (e.kind === 'tool' && e.tool === pendingConfirmTool && e.status === 'running') {
        pendingToolId = e.id
        break
      }
    }
  }

  return (
    <div className="panel" style={{ width }}>
      <div className="mode-bar">
        <button
          className={mode === 'agent' ? 'on' : ''}
          onClick={() => onModeChange('agent')}
          title="浏览器内置模型直接工作（API 直连，可选功能）"
        >
          内置模型
        </button>
        <select
          className="tool-select"
          title="切换要镜像的外部 agent 工具"
          onMouseDown={() => void refreshTools()}
          value={mode === 'agent' ? '__placeholder__' : mode === 'external' ? externalTool : 'opencode'}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__placeholder__') return
            if (v === '__add__') {
              addToolFlow()
              return
            }
            if (v === 'opencode') {
              onModeChange('opencode')
              return
            }
            onExternalToolChange(v)
          }}
        >
          <option value="__placeholder__" disabled>
            外部工具…
          </option>
          <option value="opencode">opencode（双向镜像）</option>
          {tools
            .filter((t) => t.id !== 'opencode')
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.available ? '' : '（未检测到）'}
              </option>
            ))}
          <option value="__add__">＋ 添加自定义工具…</option>
        </select>
      </div>

      {isAgent ? (
        <div className="panel-header">
          <span className={`dot ${agentSessionState === 'busy' ? 'busy' : agentConfigured ? 'ok' : 'idle'}`} />
          <span className="panel-status">
            {agentSessionState === 'busy'
              ? '内置模型工作中…'
              : agentConfigured
                ? '内置模型就绪'
                : '未配置模型'}
          </span>
          <button className="session-btn" onClick={() => setShowProviders((v) => !v)} title="模型配置">
            ⚙
          </button>
          <button className="session-btn" onClick={() => setShowSkills((v) => !v)} title="Skills 与 CLI 接入">
            ✦
          </button>
          <button className="session-btn" onClick={toggleAgentSessions} title="历史对话">
            ☰
          </button>
          <button className="panel-collapse" title="收起面板" onClick={onCollapse}>
            »
          </button>
        </div>
      ) : mode === 'external' ? (
        <ExternalToolPanel
          toolId={externalTool}
          tool={tools.find((t) => t.id === externalTool) ?? null}
          onCollapse={onCollapse}
          onOpenedChange={setExternalOpened}
          onToolRemoved={() => {
            void refreshTools()
            onModeChange('opencode')
          }}
        />
      ) : (
        <div className="panel-header">
          <span className={`dot ${busy ? 'busy' : connected ? 'ok' : 'idle'}`} />
          <span className="panel-status">
            {creatingSession
              ? '正在创建对话…'
              : busy
                ? 'AI 正在工作…'
                : connected
                  ? 'AI 已连接'
                  : '等待 AI 连接'}
          </span>
          <button
            className="session-btn"
            onClick={toggleSessionMenu}
            title="选择要连接的 opencode 对话"
          >
            <span className="session-btn-label">
              {sessionInfo?.activeSessionID ? sessionInfo.activeTitle || '已选对话' : '自动'}
            </span>
            <span className="session-btn-caret">▾</span>
          </button>
          <button className="panel-collapse" title="收起面板" onClick={onCollapse}>
            »
          </button>
        </div>
      )}

      {!isAgent && mode !== 'external' && sessionMenu && (
        <>
          <div className="session-menu-backdrop" onClick={() => setSessionMenu(false)} />
          <div className="session-menu">
            <div className="session-menu-title">连接的 opencode 对话</div>
            <button className="session-item session-new-top" onClick={createSession}>
              ＋ 新建对话
            </button>
            <button
              className={`session-item ${!sessionInfo?.activeSessionID ? 'on' : ''}`}
              onClick={() => pickSession(null)}
            >
              <span className="session-item-title">自动（跟随最近对话）</span>
            </button>
            {(sessionInfo?.sessions ?? []).map((s) => (
              <button
                key={s.id}
                className={`session-item ${sessionInfo?.activeSessionID === s.id ? 'on' : ''}`}
                onClick={() => pickSession(s.id, s.title)}
              >
                <span className="session-item-title">{s.title}</span>
                <span className="session-item-time">{timeAgo(s.updated)}</span>
              </button>
            ))}
            {(sessionInfo?.sessions ?? []).length === 0 && (
              <div className="session-empty">暂无对话列表 — 可在顶部新建一个</div>
            )}
          </div>
        </>
      )}

      {isAgent && agentSessionMenu && (
        <>
          <div className="session-menu-backdrop" onClick={() => setAgentSessionMenu(false)} />
          <div className="session-menu">
            <div className="session-menu-title">历史对话（保存在本机）</div>
            <button className="session-item session-new-top" onClick={newAgentSession}>
              ＋ 新建对话
            </button>
            {agentSessions.length === 0 && <div className="session-empty">暂无历史对话</div>}
            {agentSessions.map((s) => (
              <button
                key={s.id}
                className={`session-item ${s.current ? 'on' : ''}`}
                onClick={() => switchAgentSession(s.id)}
              >
                <span className="session-item-title">{s.title}</span>
                <span className="session-item-time">{timeAgo(s.updatedAt)}</span>
                <span
                  className={`session-del ${confirmAgentDel?.id === s.id ? 'danger' : ''}`}
                  title="删除对话（需连续确认三次）"
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    deleteAgentSession(s.id)
                  }}
                >
                  {confirmAgentDel?.id === s.id
                    ? confirmAgentDel.stage === 1
                      ? '确认?'
                      : '再确认!'
                    : '✕'}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {isAgent && showProviders && (
        <ProvidersPanel onClose={() => setShowProviders(false)} onChanged={refreshAgentReady} />
      )}

      {isAgent && showSkills && <SkillsPanel onClose={() => setShowSkills(false)} />}

      <div className="panel-list" ref={listRef} onScroll={onScroll}>
        {isAgent ? (
          <>
            {agentVisible.length === 0 && (
              <div className="empty">
                {agentConfigured ? (
                  '和内置模型对话，它会直接操控这个浏览器'
                ) : (
                  <>
                    还没有可用的模型配置
                    <div className="empty-action">
                      <button className="send-btn" onClick={() => setShowProviders(true)}>
                        打开配置
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            {agentVisible.map((ev) => (
              <MirrorItem key={ev.id} ev={ev} pendingToolId={pendingToolId} />
            ))}
          </>
        ) : (
          <>
            {visibleEvents.length === 0 && localMsgs.length === 0 && (
              <div className="empty">向 AI 发送消息开始协作</div>
            )}
            {visibleEvents.map((ev) => (
              <MirrorItem key={ev.id} ev={ev} pendingToolId={pendingToolId} />
            ))}
            {localMsgs.map((lm) => (
              <div key={lm.id} className="msg user pending-send">
                <div className="msg-body">{lm.text}</div>
              </div>
            ))}
          </>
        )}
        {confirms.map((c) => (
          <PermissionCard key={c.id} req={c} onRespond={onConfirmRespond} />
        ))}
      </div>

      {(agentError || agentSessionError || externalErr) && (
        <div className="agent-error">{agentError || agentSessionError || externalErr}</div>
      )}

      {addOpen && (
        <div
          className="confirm-overlay"
          onClick={(e) => {
            e.stopPropagation()
            if (e.target === e.currentTarget) setAddOpen(false)
          }}
        >
          <div className="confirm-box">
            <div className="confirm-title">添加自定义 Agent 工具</div>
            <label className="add-tool-field">
              <span>工具名称</span>
              <input
                value={addName}
                spellCheck={false}
                placeholder="例如：Gemini CLI"
                onChange={(e) => setAddName(e.target.value)}
              />
            </label>
            <label className="add-tool-field">
              <span>会话记录目录（包含 .jsonl / .json 会话文件）</span>
              <input
                value={addDir}
                spellCheck={false}
                placeholder="例如：C:\Users\me\.gemini\tmp"
                onChange={(e) => setAddDir(e.target.value)}
              />
            </label>
            <label className="add-tool-field">
              <span>
                启动命令（可选——填了才能从面板发消息；默认从 stdin 读，支持 {'{prompt}'} 占位。指令可能含
                cmd 特殊字符时请用 stdin 模式：命令中不要出现 {'{prompt}'}）
              </span>
              <input
                value={addCmd}
                spellCheck={false}
                placeholder="例如：gemini   或   my-agent --prompt {prompt}"
                onChange={(e) => setAddCmd(e.target.value)}
              />
            </label>
            {addErr && <div className="agent-form-err">{addErr}</div>}
            <div className="confirm-row">
              <button className="import-btn" onClick={() => setAddOpen(false)}>
                取消
              </button>
              <button
                className="send-btn"
                disabled={!addName.trim() || !addDir.trim() || addBusy}
                onClick={() => void submitAddTool()}
              >
                {addBusy ? '添加中…' : '添加'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="composer">
        <textarea
          ref={composerRef}
          rows={1}
          value={draft}
          disabled={
            mode === 'external' && (externalPending || (!extReplyReady && !externalCanStart))
          }
          placeholder={
            isAgent
              ? agentConfigured
                ? '给内置模型下指令（Enter 发送）'
                : '请先配置模型'
              : mode === 'external'
                ? extReplyReady
                  ? '回复当前会话（Enter 发送，将续接该会话）'
                  : externalCanStart
                    ? '输入第一条消息，以无头模式启动新会话（Enter 发送）'
                    : '只读镜像：请在对应的 CLI 中继续对话'
                : '给 AI 发消息（Enter 发送，Shift+Enter 换行）'
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        {isAgent && agentSessionState === 'busy' ? (
          <button className="send-btn stop" onClick={() => void window.cobrowse.agentAbort()}>
            停止
          </button>
        ) : mode === 'external' && (externalPending || agentChildren > 0) ? (
          <button
            className="send-btn stop"
            title="紧急停止：终止从面板发起的任务进程"
            onClick={() => {
              setExternalPending(false)
              void window.cobrowse.agentsStop()
            }}
          >
            停止
          </button>
        ) : (
          <button
            className="send-btn"
            onClick={send}
            disabled={
              !draft.trim() ||
              (isAgent && !agentConfigured) ||
              (mode === 'external' && (externalPending || (!extReplyReady && !externalCanStart)))
            }
          >
            {externalPending ? (extReplyReady ? '发送中…' : '启动中…') : '发送'}
          </button>
        )}
      </div>
    </div>
  )
}
