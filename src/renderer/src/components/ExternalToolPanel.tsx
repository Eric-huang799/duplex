import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import type { I18nKey } from '../../../shared/i18n'

type TFn = (key: I18nKey, vars?: Record<string, string | number>) => string
import type { ExternalSessionState } from '../../../shared/protocol'

export interface AgentToolInfo {
  id: string
  name: string
  kind: 'opencode' | 'codex' | 'claude' | 'gemini' | 'qwen' | 'custom'
  builtin: boolean
  available: boolean
  sessionsDir?: string
  command?: string
  note?: string
}

interface SessionInfo {
  id: string
  title: string
  updatedAt: number
  file: string
}

function timeAgo(t: TFn, ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return t('time.secondsAgo', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('time.minutesAgo', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('time.hoursAgo', { n: h })
  return t('time.daysAgo', { n: Math.floor(h / 24) })
}

/**
 * Mirror of an external CLI agent (Codex / Claude Code / custom):
 * pick a session transcript, replay its history into the panel, then keep
 * tailing the file so new messages appear live. For Codex and Claude Code the
 * panel can also reply: the message is injected by headlessly resuming the
 * same session (the CLI appends to the transcript, which the tail picks up).
 */
export function ExternalToolPanel({
  toolId,
  tool,
  onCollapse,
  onToolRemoved,
  onOpenedChange
}: {
  toolId: string
  tool: AgentToolInfo | null
  onCollapse: () => void
  onToolRemoved: () => void
  onOpenedChange?: (opened: { id: string; title: string } | null) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [opened, setOpened] = useState<{ id: string; title: string } | null>(null)
  const [newHint, setNewHint] = useState(false)
  const [delStage, setDelStage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [model, setModel] = useState('')
  const [customMode, setCustomMode] = useState(false)
  const [customInput, setCustomInput] = useState('')
  const [syncStage, setSyncStage] = useState(0)
  const [modelMsg, setModelMsg] = useState('')
  const [watchError, setWatchError] = useState(false)
  const delTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (delTimerRef.current != null) window.clearTimeout(delTimerRef.current)
    }
  }, [])

  const refresh = async (): Promise<void> => {
    setError('')
    try {
      const list = (await window.cobrowse.agentsSessions(toolId)) as SessionInfo[]
      setSessions(Array.isArray(list) ? list : [])
    } catch (e) {
      setError((e as Error)?.message ?? t('ext.readSessionsFailed'))
    }
  }

  useEffect(() => {
    setNewHint(false)
    setMenuOpen(false)
    setWatchError(false)
    let live = true
    let received = false
    const applyState = (state: ExternalSessionState | null): void => {
      if (!live) return
      const info = state?.toolId === toolId ? { id: state.sessionId, title: state.title } : null
      setOpened(info)
      onOpenedChange?.(info)
      if (info) { setNewHint(false); setWatchError(false) }
    }
    const off = window.cobrowse.onExternalState((state) => { received = true; applyState(state) })
    void window.cobrowse.externalState().then((state) => { if (!received) applyState(state) })
    void refresh()
    return () => {
      live = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId])

  // The transcript tail can lose its file handle (moved/deleted/rewritten);
  // show a banner until the user successfully reopens the session.
  useEffect(() => {
    const off = window.cobrowse.onAgentsWatchError((s) => {
      if (s.toolId === toolId) setWatchError(true)
    })
    return off
  }, [toolId])

  // Esc closes the session menu.
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  const open = async (s: SessionInfo): Promise<void> => {
    setBusy(true)
    setError('')
    const r = await window.cobrowse.agentsSessionOpen(toolId, s.id, s.file)
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? t('ext.openFailed'))
      return
    }
    setNewHint(false)
    setMenuOpen(false)
    setWatchError(false)
  }

  const modelCapable = tool?.kind === 'codex' || tool?.kind === 'claude'

  useEffect(() => {
    setModels([])
    setModel('')
    setCustomMode(false)
    setCustomInput('')
    setSyncStage(0)
    setModelMsg('')
    if (!toolId) return
    void window.cobrowse.agentsModels(toolId).then((r) => {
      setModels(Array.isArray(r?.candidates) ? r.candidates : [])
      setModel(typeof r?.current === 'string' ? r.current : '')
    })
  }, [toolId])

  const saveModel = async (value: string): Promise<void> => {
    setModelMsg('')
    const r = await window.cobrowse.agentsModelSet(toolId, value)
    if (!r.ok) {
      setModelMsg(r.error ?? t('ext.saveFailed'))
      return
    }
    setModel(value)
    setModelMsg(
      value ? t('ext.modelSelected', { name: value }) : t('ext.modelDefault')
    )
  }

  const syncModel = async (): Promise<void> => {
    if (syncStage === 0) {
      setSyncStage(1)
      setModelMsg(t('ext.syncConfirm'))
      setTimeout(() => setSyncStage(0), 4000)
      return
    }
    setSyncStage(0)
    const r = await window.cobrowse.agentsModelSyncGlobal(toolId)
    setModelMsg(r.ok ? t('ext.synced', { path: r.backupPath ?? '' }) : (r.error ?? t('ext.syncFailed')))
  }

  const armDelReset = (): void => {
    if (delTimerRef.current != null) window.clearTimeout(delTimerRef.current)
    delTimerRef.current = window.setTimeout(() => setDelStage(0), 4000)
  }

  const removeTool = async (): Promise<void> => {
    if (!tool || tool.builtin) return
    if (delStage === 0) {
      setDelStage(1)
      armDelReset()
      return
    }
    if (delStage === 1) {
      setDelStage(2)
      armDelReset()
      return
    }
    if (delTimerRef.current != null) {
      window.clearTimeout(delTimerRef.current)
      delTimerRef.current = null
    }
    setDelStage(0)
    await window.cobrowse.agentsRemove(tool.id)
    onToolRemoved()
  }

  const available = !!tool?.available
  const canReply = tool?.kind === 'codex' || tool?.kind === 'claude'
  /** Mirrors the composer's enable rule so the hint never contradicts it. */
  const canStartFromPanel =
    available &&
    (tool?.kind === 'codex' ||
      tool?.kind === 'claude' ||
      tool?.kind === 'gemini' ||
      tool?.kind === 'qwen' ||
      (tool?.kind === 'custom' && !!tool?.command))

  return (
    <>
      <div className="panel-header">
        <span className={`dot ${available ? 'ok' : 'idle'}`} />
        <span className="panel-status">
          {tool ? `${tool.name}${available ? '' : t('panel.notDetected')}` : t('ext.notSelectedTool')}
        </span>
        <button className="session-btn" onClick={() => void refresh()} title={t('ext.refreshSessions')}>
          ⟳
        </button>
        <button
          className="session-btn"
          onClick={() => {
            setMenuOpen((v) => !v)
            if (!menuOpen) void refresh()
          }}
          title={t('ext.historySessions')}
        >
          ☰
        </button>
        {tool && !tool.builtin && (
          <button
            className={`session-btn ${delStage > 0 ? 'danger' : ''}`}
            onClick={() => void removeTool()}
            title={t('ext.removeTool')}
          >
            {delStage === 0 ? '✕' : delStage === 1 ? t('panel.confirmOne') : t('panel.confirmAgain')}
          </button>
        )}
        <button className="panel-collapse" title={t('ext.collapse')} onClick={onCollapse}>
          »
        </button>
      </div>

      {tool?.note && <div className="external-hint">{tool.note}</div>}

      {modelCapable && (
        <div className="model-row">
          <span className="model-row-label">{t('ext.model')}</span>
          {customMode ? (
            <>
              <input
                className="model-input"
                value={customInput}
                spellCheck={false}
                placeholder={t('ext.modelPlaceholder')}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customInput.trim()) {
                    void saveModel(customInput.trim())
                    setCustomMode(false)
                  }
                }}
              />
              <button
                className="model-sync"
                onClick={() => {
                  if (customInput.trim()) void saveModel(customInput.trim())
                  setCustomMode(false)
                }}
              >
                {t('common.save')}
              </button>
            </>
          ) : (
            <>
              <select
                className="model-select"
                value={model}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === '__custom__') {
                    setCustomMode(true)
                    setCustomInput(models.some((m) => m.id === model) ? '' : model)
                    return
                  }
                  void saveModel(v)
                }}
              >
                <option value="">{t('ext.defaultCli')}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                {model && !models.some((m) => m.id === model) && (
                  <option value={model}>{t('ext.customSuffix', { model })}</option>
                )}
                <option value="__custom__">{t('ext.customOption')}</option>
              </select>
              <button
                className={`model-sync ${syncStage > 0 ? 'danger' : ''}`}
                title={t('ext.writeGlobalTitle')}
                onClick={() => void syncModel()}
              >
                {syncStage === 0 ? t('ext.globalButton') : t('ext.confirmWrite')}
              </button>
            </>
          )}
        </div>
      )}
      {modelMsg && <div className="external-hint">{modelMsg}</div>}

      {menuOpen && (
        <>
          <div className="session-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="session-menu">
            <div className="session-menu-title">
              {t('ext.historySessionsWith', { name: tool?.name ?? '', n: sessions.length })}
            </div>
            <button
              className="session-item session-new-top"
              onClick={() => {
                void window.cobrowse.agentsSessionClose().then((r) => {
                  if (r.ok) { setNewHint(true); setMenuOpen(false) }
                })
              }}
            >
              {t('ext.newChat')}
            </button>
            {sessions.length === 0 && <div className="session-empty">{t('ext.noSessions')}</div>}
            {sessions.slice(0, 60).map((s) => (
              <button
                key={s.id}
                className={`session-item ${opened?.id === s.id ? 'on' : ''}`}
                onClick={() => void open(s)}
                title={s.file}
              >
                <span className="session-item-title">{s.title}</span>
                <span className="session-item-time">{timeAgo(t, s.updatedAt)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {watchError && (
        <div className="watch-error-banner" role="status">
          {t('ext.syncDisconnected')}
        </div>
      )}
      {error && <div className="agent-error">{error}</div>}
      {busy && <div className="external-hint">{t('ext.loadingSessions')}</div>}
      {!busy && newHint && !opened && (
        <div className="external-hint">
          {!tool
            ? t('ext.pickTool')
            : !available
              ? t('ext.cmdUnavailable', { name: tool.name })
              : canStartFromPanel
                ? t('ext.newHeadless')
                : t('ext.noSend')}
        </div>
      )}
      {!busy && opened && (
        <div className="external-hint">
          {t('ext.opened', { title: opened.title })}
          {canReply ? t('ext.replyInline') : t('ext.readOnly')}
        </div>
      )}
    </>
  )
}
