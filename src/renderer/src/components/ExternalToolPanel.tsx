import { useEffect, useState } from 'react'

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

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
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

  const refresh = async (): Promise<void> => {
    setError('')
    try {
      const list = (await window.cobrowse.agentsSessions(toolId)) as SessionInfo[]
      setSessions(Array.isArray(list) ? list : [])
    } catch (e) {
      setError((e as Error)?.message ?? '读取会话列表失败')
    }
  }

  useEffect(() => {
    setOpened(null)
    onOpenedChange?.(null)
    setNewHint(false)
    setMenuOpen(false)
    void window.cobrowse.agentsSessionClose()
    void window.cobrowse.agentsSetMirrorSource('external')
    void refresh()
    return () => {
      onOpenedChange?.(null)
      void window.cobrowse.agentsSessionClose()
      void window.cobrowse.agentsSetMirrorSource('opencode')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId])

  const open = async (s: SessionInfo): Promise<void> => {
    setBusy(true)
    setError('')
    const r = await window.cobrowse.agentsSessionOpen(toolId, s.id, s.file)
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? '打开失败')
      return
    }
    const info = { id: s.id, title: r.title ?? s.title }
    setOpened(info)
    onOpenedChange?.(info)
    setNewHint(false)
    setMenuOpen(false)
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
      setModelMsg(r.error ?? '保存失败')
      return
    }
    setModel(value)
    setModelMsg(
      value ? `已选择：${value}（对面板发起/续聊的会话生效）` : '已恢复默认（跟随 CLI 配置）'
    )
  }

  const syncModel = async (): Promise<void> => {
    if (syncStage === 0) {
      setSyncStage(1)
      setModelMsg('将写入全局 CLI 配置——影响该 CLI 的全部会话（不只 Duplex），确认后写入并自动备份')
      setTimeout(() => setSyncStage(0), 4000)
      return
    }
    setSyncStage(0)
    const r = await window.cobrowse.agentsModelSyncGlobal(toolId)
    setModelMsg(r.ok ? `已写入全局配置（备份：${r.backupPath ?? ''}）` : (r.error ?? '同步失败'))
  }

  const removeTool = async (): Promise<void> => {
    if (!tool || tool.builtin) return
    if (delStage === 0) {
      setDelStage(1)
      setTimeout(() => setDelStage(0), 4000)
      return
    }
    if (delStage === 1) {
      setDelStage(2)
      return
    }
    setDelStage(0)
    await window.cobrowse.agentsRemove(tool.id)
    onToolRemoved()
  }

  const available = !!tool?.available
  const canReply = tool?.kind === 'codex' || tool?.kind === 'claude'

  return (
    <>
      <div className="panel-header">
        <span className={`dot ${available ? 'ok' : 'idle'}`} />
        <span className="panel-status">
          {tool ? `${tool.name}${available ? '' : '（未检测到）'}` : '未选择工具'}
        </span>
        <button className="session-btn" onClick={() => void refresh()} title="刷新会话列表">
          ⟳
        </button>
        <button
          className="session-btn"
          onClick={() => {
            setMenuOpen((v) => !v)
            if (!menuOpen) void refresh()
          }}
          title="历史会话"
        >
          ☰
        </button>
        {tool && !tool.builtin && (
          <button
            className={`session-btn ${delStage > 0 ? 'danger' : ''}`}
            onClick={() => void removeTool()}
            title="移除该自定义工具（需连续确认三次）"
          >
            {delStage === 0 ? '✕' : delStage === 1 ? '确认?' : '再确认!'}
          </button>
        )}
        <button className="panel-collapse" title="收起面板" onClick={onCollapse}>
          »
        </button>
      </div>

      {modelCapable && (
        <div className="model-row">
          <span className="model-row-label">模型</span>
          {customMode ? (
            <>
              <input
                className="model-input"
                value={customInput}
                spellCheck={false}
                placeholder="输入模型名，回车保存"
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
                保存
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
                <option value="">默认（跟随 CLI 配置）</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                {model && !models.some((m) => m.id === model) && (
                  <option value={model}>{model}（自定义）</option>
                )}
                <option value="__custom__">自定义…</option>
              </select>
              <button
                className={`model-sync ${syncStage > 0 ? 'danger' : ''}`}
                title="写入全局 CLI 配置：影响该 CLI 的全部会话（自动备份）"
                onClick={() => void syncModel()}
              >
                {syncStage === 0 ? '⇪ 全局' : '确认写入'}
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
              历史会话（{tool?.name ?? ''} · {sessions.length} 个）
            </div>
            <button
              className="session-item session-new-top"
              onClick={() => {
                setNewHint(true)
                setOpened(null)
                onOpenedChange?.(null)
                setMenuOpen(false)
              }}
            >
              ＋ 新建对话
            </button>
            {sessions.length === 0 && <div className="session-empty">未找到会话记录</div>}
            {sessions.slice(0, 60).map((s) => (
              <button
                key={s.id}
                className={`session-item ${opened?.id === s.id ? 'on' : ''}`}
                onClick={() => void open(s)}
                title={s.file}
              >
                <span className="session-item-title">{s.title}</span>
                <span className="session-item-time">{timeAgo(s.updatedAt)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {error && <div className="agent-error">{error}</div>}
      {busy && <div className="external-hint">正在加载会话…</div>}
      {!busy && newHint && !opened && (
        <div className="external-hint">
          新对话：在下方输入第一条消息，将以无头模式启动（Enter 发送）
        </div>
      )}
      {!busy && opened && (
        <div className="external-hint">
          已打开：{opened.title}
          {canReply ? '（可直接在下方回复，将续接该会话）' : '（只读镜像，新消息自动同步）'}
        </div>
      )}
    </>
  )
}
