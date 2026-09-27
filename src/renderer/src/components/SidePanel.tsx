import { useEffect, useRef, useState } from 'react'
import type {
  MirrorAnnotationEvent,
  MirrorEvent,
  MirrorSessionInfoEvent
} from '../../../shared/protocol'
import type { LocalMessage } from '../App'
import { ToolCard } from './ToolCard'
import { MarkdownProse } from './Markdown'
import { ProvidersPanel } from './ProvidersPanel'

export type PanelMode = 'opencode' | 'agent'

interface Props {
  width: number
  events: MirrorEvent[]
  localMsgs: LocalMessage[]
  onSend: (text: string) => void
  onCollapse: () => void
  mode: PanelMode
  onModeChange: (m: PanelMode) => void
  agentEvents: MirrorEvent[]
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

function MirrorItem({ ev }: { ev: MirrorEvent }): React.JSX.Element | null {
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
    return <ToolCard ev={ev} open={open} onToggle={() => setOpen((v) => !v)} />
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
  agentEvents
}: Props): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [sessionMenu, setSessionMenu] = useState(false)
  const [showProviders, setShowProviders] = useState(false)
  const [agentReady, setAgentReady] = useState(false)
  const [agentError, setAgentError] = useState('')
  const [agentSessionMenu, setAgentSessionMenu] = useState(false)
  const [agentSessions, setAgentSessions] = useState<
    Array<{ id: string; title: string; updatedAt: number; current: boolean }>
  >([])
  const [confirmAgentDel, setConfirmAgentDel] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

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
    if (confirmAgentDel !== id) {
      setConfirmAgentDel(id)
      setTimeout(() => setConfirmAgentDel((c) => (c === id ? null : c)), 3000)
      return
    }
    void window.cobrowse.agentDeleteSession(id).then(() => {
      setConfirmAgentDel(null)
      void window.cobrowse.agentSessions().then(setAgentSessions)
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

  const send = (): void => {
    const t = draft.trim()
    if (!t) return
    setDraft('')
    if (isAgent) {
      setAgentError('')
      void window.cobrowse.agentSend(t).then((res) => {
        if (!res.ok && res.error) setAgentError(res.error)
      })
    } else {
      onSend(t)
    }
  }

  // ------- opencode-mode derived state -------
  const busy = events.some(
    (e) => e.kind === 'tool' && (e.status === 'running' || e.status === 'pending')
  )
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
    void window.cobrowse.sessionCommand({ action: 'create' })
    setSessionMenu(false)
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

  return (
    <div className="panel" style={{ width }}>
      <div className="mode-bar">
        <button
          className={mode === 'opencode' ? 'on' : ''}
          onClick={() => onModeChange('opencode')}
          title="通过 opencode 会话工作（镜像对话 + 会话选择）"
        >
          opencode
        </button>
        <button
          className={mode === 'agent' ? 'on' : ''}
          onClick={() => onModeChange('agent')}
          title="浏览器内置模型直接工作（API 直连，可选功能）"
        >
          内置模型
        </button>
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
          <button className="session-btn" onClick={toggleAgentSessions} title="历史对话">
            ☰
          </button>
          <button className="session-btn" onClick={newAgentSession} title="新对话">
            ＋
          </button>
          <button className="panel-collapse" title="收起面板" onClick={onCollapse}>
            »
          </button>
        </div>
      ) : (
        <div className="panel-header">
          <span className={`dot ${busy ? 'busy' : connected ? 'ok' : 'idle'}`} />
          <span className="panel-status">
            {busy ? 'AI 正在工作…' : connected ? 'AI 已连接' : '等待 AI 连接'}
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

      {!isAgent && sessionMenu && (
        <>
          <div className="session-menu-backdrop" onClick={() => setSessionMenu(false)} />
          <div className="session-menu">
            <div className="session-menu-title">连接的 opencode 对话</div>
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
              <div className="session-empty">暂无对话列表 — 可新建一个</div>
            )}
            <button className="session-new" onClick={createSession}>
              ＋ 新建对话
            </button>
          </div>
        </>
      )}

      {isAgent && agentSessionMenu && (
        <>
          <div className="session-menu-backdrop" onClick={() => setAgentSessionMenu(false)} />
          <div className="session-menu">
            <div className="session-menu-title">历史对话（保存在本机）</div>
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
                  className={`session-del ${confirmAgentDel === s.id ? 'danger' : ''}`}
                  title="删除对话"
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    deleteAgentSession(s.id)
                  }}
                >
                  {confirmAgentDel === s.id ? '确认' : '✕'}
                </span>
              </button>
            ))}
            <button className="session-new" onClick={newAgentSession}>
              ＋ 新对话
            </button>
          </div>
        </>
      )}

      {isAgent && showProviders && (
        <ProvidersPanel onClose={() => setShowProviders(false)} onChanged={refreshAgentReady} />
      )}

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
              <MirrorItem key={ev.id} ev={ev} />
            ))}
          </>
        ) : (
          <>
            {events.length === 0 && localMsgs.length === 0 && (
              <div className="empty">向 AI 发送消息开始协作</div>
            )}
            {visibleEvents.map((ev) => (
              <MirrorItem key={ev.id} ev={ev} />
            ))}
            {localMsgs.map((lm) => (
              <div key={lm.id} className="msg user pending-send">
                <div className="msg-body">{lm.text}</div>
              </div>
            ))}
          </>
        )}
      </div>

      {(agentError || agentSessionError) && (
        <div className="agent-error">{agentError || agentSessionError}</div>
      )}

      <div className="composer">
        <textarea
          rows={2}
          value={draft}
          placeholder={
            isAgent
              ? agentConfigured
                ? '给内置模型下指令（Enter 发送）'
                : '请先配置模型'
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
        ) : (
          <button className="send-btn" onClick={send} disabled={!draft.trim() || (isAgent && !agentConfigured)}>
            发送
          </button>
        )}
      </div>
    </div>
  )
}
