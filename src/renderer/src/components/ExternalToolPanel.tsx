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
 * Read-only mirror of an external CLI agent (Codex / Claude Code / custom):
 * pick a session transcript, replay its history into the panel, then keep
 * tailing the file so new messages appear live.
 */
export function ExternalToolPanel({
  toolId,
  tool,
  onCollapse,
  onToolRemoved
}: {
  toolId: string
  tool: AgentToolInfo | null
  onCollapse: () => void
  onToolRemoved: () => void
}): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [opened, setOpened] = useState<{ id: string; title: string } | null>(null)
  const [newHint, setNewHint] = useState(false)
  const [delStage, setDelStage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
    setNewHint(false)
    setMenuOpen(false)
    void window.cobrowse.agentsSessionClose()
    void window.cobrowse.agentsSetMirrorSource('external')
    void refresh()
    return () => {
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
    setOpened({ id: s.id, title: r.title ?? s.title })
    setNewHint(false)
    setMenuOpen(false)
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
          已打开：{opened.title}（只读镜像，新消息自动同步）
        </div>
      )}
    </>
  )
}
