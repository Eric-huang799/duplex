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
import { useI18n } from '../i18n'
import type { I18nKey } from '../../../shared/i18n'

type TFn = (key: I18nKey, vars?: Record<string, string | number>) => string

export type PanelMode = 'opencode' | 'agent' | 'external'

const DRAFT_KEYS: Record<PanelMode, string> = {
  agent: 'duplex-draft-agent',
  opencode: 'duplex-draft-opencode',
  external: 'duplex-draft-external'
}

function loadDraft(mode: PanelMode): string {
  try {
    return localStorage.getItem(DRAFT_KEYS[mode]) ?? ''
  } catch {
    return ''
  }
}

function saveDraft(mode: PanelMode, value: string): void {
  try {
    if (value) localStorage.setItem(DRAFT_KEYS[mode], value)
    else localStorage.removeItem(DRAFT_KEYS[mode])
  } catch {
    /* storage may be unavailable */
  }
}

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

function timeAgo(t: TFn, ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return t('time.justNow')
  if (m < 60) return t('time.minutesAgo', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('time.hoursAgo', { n: h })
  return t('time.daysAgo', { n: Math.floor(h / 24) })
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
  const { t } = useI18n()
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
        <summary>{t('panel.thinking')}</summary>
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
      return <div className="session-line err">{t('panel.sessionError', { err: ev.error ?? t('panel.unknownError') })}</div>
    }
    return <div className="session-line">{t('panel.roundEnd')}</div>
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
  const { t } = useI18n()
  const [draft, setDraft] = useState(() => loadDraft(mode))
  const draftRef = useRef(draft)
  const draftModeRef = useRef(mode)
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
  const [addCwd, setAddCwd] = useState('')
  const [addErr, setAddErr] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [dismissedAgentSessionErrTs, setDismissedAgentSessionErrTs] = useState<number | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const agentDelTimerRef = useRef<number | null>(null)

  const updateDraft = (value: string): void => {
    draftRef.current = value
    setDraft(value)
    saveDraft(mode, value)
  }

  const clearDraftIfUnchanged = (sent: string): void => {
    if (draftModeRef.current !== mode) return
    if (draftRef.current.trim() !== sent) return
    updateDraft('')
  }

  // Drafts are per-mode and persist across panel collapse; switching the mode
  // saves the current draft and restores the target mode's own draft.
  useEffect(() => {
    if (draftModeRef.current === mode) return
    saveDraft(draftModeRef.current, draftRef.current)
    draftModeRef.current = mode
    draftRef.current = loadDraft(mode)
    setDraft(draftRef.current)
  }, [mode])

  useEffect(() => {
    return () => {
      if (agentDelTimerRef.current != null) window.clearTimeout(agentDelTimerRef.current)
    }
  }, [])

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
    setAddCwd('')
    setAddErr('')
    setAddOpen(true)
  }

  const submitAddTool = async (): Promise<void> => {
    if (addBusy) return
    const name = addName.trim()
    const dir = addDir.trim()
    if (!name || !dir) return
    setAddBusy(true)
    setAddErr('')
    const r = await window.cobrowse.agentsAdd(
      name,
      dir,
      addCmd.trim() || undefined,
      addCwd.trim() || undefined
    )
    setAddBusy(false)
    if (!r.ok) {
      setAddErr(r.error ?? t('panel.addFailed'))
      return
    }
    setAddOpen(false)
    await refreshTools()
    if (r.id) onExternalToolChange(r.id)
  }

  const onAddInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter') return
    if ((e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229) return
    e.preventDefault()
    void submitAddTool()
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
  const [modifyNextSend, setModifyNextSend] = useState(false)
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

  const armAgentDelReset = (id: string): void => {
    if (agentDelTimerRef.current != null) window.clearTimeout(agentDelTimerRef.current)
    agentDelTimerRef.current = window.setTimeout(
      () => setConfirmAgentDel((c) => (c && c.id === id ? null : c)),
      4000
    )
  }

  const switchAgentSession = (id: string): void => {
    setAgentError('')
    void window.cobrowse.agentSwitchSession(id).then((r) => {
      if (!r.ok) {
        if (r.error) setAgentError(r.error)
        return
      }
      setAgentSessionMenu(false)
    })
  }

  const deleteAgentSession = (id: string): void => {
    if (!confirmAgentDel || confirmAgentDel.id !== id) {
      setConfirmAgentDel({ id, stage: 1 })
      armAgentDelReset(id)
      return
    }
    if (confirmAgentDel.stage === 1) {
      setConfirmAgentDel({ id, stage: 2 })
      armAgentDelReset(id)
      return
    }
    if (agentDelTimerRef.current != null) {
      window.clearTimeout(agentDelTimerRef.current)
      agentDelTimerRef.current = null
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
    setAgentError('')
    void window.cobrowse.agentNewSession().then((r) => {
      if (!r.ok) {
        if (r.error) setAgentError(r.error)
        return
      }
      setAgentSessionMenu(false)
    })
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
    const text = draft.trim()
    if (!text) return
    if (mode === 'external') {
      if (extReplyReady) {
        if (externalPending) return
        setExternalErr('')
        setExternalPending(true)
        void window.cobrowse.agentsSessionSend(externalTool, text).then((r) => {
          setExternalPending(false)
          if (!r.ok) {
            setExternalErr(r.error ?? t('panel.sendFailed'))
            return
          }
          clearDraftIfUnchanged(text)
        })
        return
      }
      if (!externalCanStart || externalPending) return
      setExternalErr('')
      setExternalPending(true)
      void window.cobrowse.agentsStartSession(externalTool, text).then((r) => {
        setExternalPending(false)
        if (!r.ok) {
          setExternalErr(r.error ?? t('panel.startFailed'))
          return
        }
        clearDraftIfUnchanged(text)
      })
      return
    }
    if (isAgent) {
      setAgentError('')
      void window.cobrowse.agentSend(text, modifyNextSend ? { interrupt: true } : undefined).then((res) => {
        if (res.ok) {
          clearDraftIfUnchanged(text)
          setModifyNextSend(false)
          return
        }
        if (res.error) setAgentError(res.error)
      })
      return
    }
    updateDraft('')
    onSend(text)
  }

  useEffect(() => {
    window.cobrowse.setChromeOverlay('panel-add-tool', addOpen)
    return () => window.cobrowse.setChromeOverlay('panel-add-tool', false)
  }, [addOpen])

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
    displayEvents
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
  let agentSessionErrorTs = 0
  for (let i = agentEvents.length - 1; i >= 0; i--) {
    const e = agentEvents[i]
    if (e.kind === 'session') {
      agentSessionState = e.status === 'busy' ? 'busy' : 'idle'
      if (e.status === 'error') {
        agentSessionError = e.error ?? ''
        agentSessionErrorTs = e.ts
      }
      break
    }
  }
  const sessionErrVisible =
    !!agentSessionError && agentSessionErrorTs !== dismissedAgentSessionErrTs
  const agentErrText = agentError || (sessionErrVisible ? agentSessionError : '')
  const agentConfigured = agentReady
  const agentVisible = agentEvents.filter(
    (e) =>
      e.kind !== 'session' &&
      !(e.kind === 'text' && e.role === 'user' && annotationTexts.has(e.text))
  )
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
          title={t('panel.builtinTitle')}
        >
          {t('panel.builtin')}
          {agentSessionState === 'busy' && mode !== 'agent' && (
            <span
              className="dot busy"
              style={{ display: 'inline-block', marginLeft: 5, verticalAlign: 'middle' }}
            />
          )}
        </button>
        <select
          className="tool-select"
          title={t('panel.switchTool')}
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
            {mode === 'agent' ? t('panel.switchToolOption') : t('panel.externalToolOption')}
          </option>
          <option value="opencode">{t('panel.opencodeMirror')}</option>
          {tools
            .filter((tool) => tool.id !== 'opencode')
            .map((tool) => (
              <option key={tool.id} value={tool.id}>
                {tool.name}
                {tool.available ? '' : t('panel.notDetected')}
              </option>
            ))}
          <option value="__add__">{t('panel.addCustomTool')}</option>
        </select>
      </div>

      {isAgent ? (
        <div className="panel-header">
          <span className={`dot ${agentSessionState === 'busy' ? 'busy' : agentConfigured ? 'ok' : 'idle'}`} />
          <span className="panel-status">
            {agentSessionState === 'busy'
              ? t('panel.agentBusy')
              : agentConfigured
                ? t('panel.agentReady')
                : t('panel.agentUnconfigured')}
          </span>
          <button className="session-btn" data-panel-toggle="providers" onClick={() => setShowProviders((v) => !v)} title={t('panel.modelConfig')}>
            ⚙
          </button>
          <button className="session-btn" data-panel-toggle="skills" onClick={() => setShowSkills((v) => !v)} title={t('panel.skillsCli')}>
            ✦
          </button>
          <button className="session-btn" onClick={toggleAgentSessions} title={t('panel.historyChats')}>
            ☰
          </button>
          <button className="panel-collapse" title={t('panel.collapse')} onClick={onCollapse}>
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
              ? t('panel.creatingChat')
              : busy
                ? t('panel.aiWorking')
                : connected
                  ? t('panel.aiConnected')
                  : t('panel.aiWaiting')}
          </span>
          <button
            className="session-btn"
            onClick={toggleSessionMenu}
            title={t('panel.selectOpencodeChat')}
          >
            <span className="session-btn-label">
              {sessionInfo?.activeSessionID ? sessionInfo.activeTitle || t('panel.selectedChat') : t('panel.auto')}
            </span>
            <span className="session-btn-caret">▾</span>
          </button>
          <button className="panel-collapse" title={t('panel.collapse')} onClick={onCollapse}>
            »
          </button>
        </div>
      )}

      {!isAgent && mode !== 'external' && sessionMenu && (
        <>
          <div className="session-menu-backdrop" onClick={() => setSessionMenu(false)} />
          <div className="session-menu">
            <div className="session-menu-title">{t('panel.connectedOpencode')}</div>
            <button className="session-item session-new-top" onClick={createSession}>
              {t('panel.newChat')}
            </button>
            <button
              className={`session-item ${!sessionInfo?.activeSessionID ? 'on' : ''}`}
              onClick={() => pickSession(null)}
            >
              <span className="session-item-title">{t('panel.autoFollow')}</span>
            </button>
            {(sessionInfo?.sessions ?? []).map((s) => (
              <button
                key={s.id}
                className={`session-item ${sessionInfo?.activeSessionID === s.id ? 'on' : ''}`}
                onClick={() => pickSession(s.id, s.title)}
              >
                <span className="session-item-title">{s.title}</span>
                <span className="session-item-time">{timeAgo(t, s.updated)}</span>
              </button>
            ))}
            {(sessionInfo?.sessions ?? []).length === 0 && (
              <div className="session-empty">{t('panel.noChats')}</div>
            )}
          </div>
        </>
      )}

      {isAgent && agentSessionMenu && (
        <>
          <div className="session-menu-backdrop" onClick={() => setAgentSessionMenu(false)} />
          <div className="session-menu">
            <div className="session-menu-title">{t('panel.historyChatsLocal')}</div>
            <button className="session-item session-new-top" onClick={newAgentSession}>
              {t('panel.newChat')}
            </button>
            {agentSessions.length === 0 && <div className="session-empty">{t('panel.noHistory')}</div>}
            {agentSessions.map((s) => (
              <button
                key={s.id}
                className={`session-item ${s.current ? 'on' : ''}`}
                onClick={() => switchAgentSession(s.id)}
              >
                <span className="session-item-title">{s.title}</span>
                <span className="session-item-time">{timeAgo(t, s.updatedAt)}</span>
                <span
                  className={`session-del ${confirmAgentDel?.id === s.id ? 'danger' : ''}`}
                  title={t('panel.deleteChat')}
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    deleteAgentSession(s.id)
                  }}
                >
                  {confirmAgentDel?.id === s.id
                    ? confirmAgentDel.stage === 1
                      ? t('panel.confirmOne')
                      : t('panel.confirmAgain')
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
                  t('panel.agentIntro')
                ) : (
                  <>
                    {t('panel.noProviders')}
                    <div className="empty-action">
                      <button className="send-btn" onClick={() => setShowProviders(true)}>
                        {t('panel.openConfig')}
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
              <div className="empty">
                {mode === 'external'
                  ? t('panel.agentEmptyHint')
                  : t('panel.aiEmptyHint')}
              </div>
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

      {(agentErrText || externalErr) && (
        <div className="agent-error skill-err">
          <span>
            {agentErrText ? t('panel.agentErr', { err: agentErrText }) : t('panel.externalErr', { err: externalErr ?? '' })}
          </span>
          <button
            type="button"
            title={t('panel.clearError')}
            onClick={() => {
              setAgentError('')
              setExternalErr('')
              if (agentSessionError) setDismissedAgentSessionErrTs(agentSessionErrorTs)
            }}
          >
            ×
          </button>
        </div>
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
            <div className="confirm-title">{t('panel.addToolTitle')}</div>
            <label className="add-tool-field">
              <span>{t('panel.toolName')}</span>
              <input
                value={addName}
                spellCheck={false}
                placeholder={t('panel.toolNamePlaceholder')}
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={onAddInputKeyDown}
              />
            </label>
            <label className="add-tool-field">
              <span>{t('panel.sessionsDir')}</span>
              <input
                value={addDir}
                spellCheck={false}
                placeholder={t('panel.sessionsDirPlaceholder')}
                onChange={(e) => setAddDir(e.target.value)}
                onKeyDown={onAddInputKeyDown}
              />
            </label>
            <label className="add-tool-field">
              <span>{t('panel.launchCmd')}</span>
              <input
                value={addCmd}
                spellCheck={false}
                placeholder={t('panel.launchCmdPlaceholder')}
                onChange={(e) => setAddCmd(e.target.value)}
                onKeyDown={onAddInputKeyDown}
              />
            </label>
            <label className="add-tool-field">
              <span>{t('panel.workdir')}</span>
              <input
                value={addCwd}
                spellCheck={false}
                placeholder={t('panel.workdirPlaceholder')}
                onChange={(e) => setAddCwd(e.target.value)}
                onKeyDown={onAddInputKeyDown}
              />
            </label>
            {addErr && <div className="agent-form-err">{addErr}</div>}
            <div className="confirm-row">
              <button className="import-btn" onClick={() => setAddOpen(false)}>
                {t('common.cancel')}
              </button>
              <button
                className="send-btn"
                disabled={!addName.trim() || !addDir.trim() || addBusy}
                onClick={() => void submitAddTool()}
              >
                {addBusy ? t('panel.adding') : t('common.add')}
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
                ? t('panel.inputAgent')
                : t('panel.configureFirst')
              : mode === 'external'
                ? extReplyReady
                  ? t('panel.replySession')
                  : externalCanStart
                    ? t('panel.firstMessage')
                    : t('panel.readOnlyMirror')
                : t('panel.sendToAi')
          }
          onChange={(e) => updateDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return
            if ((e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229) return
            e.preventDefault()
            send()
          }}
        />
        {isAgent && agentSessionState === 'busy' ? (
          <div className="composer-actions">
            <button className="send-btn stop" onClick={() => void window.cobrowse.agentAbort()}>{t('panel.stop')}</button>
            <button className="send-btn" onClick={() => {
              setModifyNextSend(true)
              void window.cobrowse.agentAbort()
              composerRef.current?.focus()
            }}>{t('panel.pauseModify')}</button>
            <button className="send-btn" disabled={!draft.trim()} onClick={send}>{t('panel.queueFollowup')}</button>
          </div>
        ) : mode === 'external' && (externalPending || agentChildren > 0) ? (
          <button
            className="send-btn stop"
            title={t('panel.emergencyStopTitle')}
            onClick={() => {
              setExternalPending(false)
              void window.cobrowse.agentsStop()
            }}
          >
            {t('panel.stop')}
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
            {externalPending ? (extReplyReady ? t('panel.sending') : t('panel.starting')) : isAgent && modifyNextSend ? t('panel.sendModify') : t('panel.send')}
          </button>
        )}
      </div>
    </div>
  )
}
