import { useEffect, useState } from 'react'

interface MaskedProvider {
  id: string
  name: string
  baseUrl: string
  model: string
  hasKey: boolean
}

interface EditingState {
  id?: string
  name: string
  baseUrl: string
  model: string
  apiKey: string
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/**
 * CC-Switch-style API provider manager: keep several model configs and switch
 * the active one with a single click.
 */
export function ProvidersPanel({
  onClose,
  onChanged
}: {
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  const [providers, setProviders] = useState<MaskedProvider[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = async (): Promise<void> => {
    const s = await window.cobrowse.agentProviders()
    setProviders(s.providers)
    setActiveId(s.activeId)
    onChanged()
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activate = async (id: string): Promise<void> => {
    await window.cobrowse.agentProviderActivate(id)
    await refresh()
  }

  const remove = async (id: string): Promise<void> => {
    if (confirmDel !== id) {
      setConfirmDel(id)
      setTimeout(() => setConfirmDel((c) => (c === id ? null : c)), 3000)
      return
    }
    await window.cobrowse.agentProviderRemove(id)
    setConfirmDel(null)
    await refresh()
  }

  const saveEdit = async (): Promise<void> => {
    if (!editing || busy) return
    setBusy(true)
    setError('')
    const res = await window.cobrowse.agentProviderSave({
      id: editing.id,
      name: editing.name,
      baseUrl: editing.baseUrl,
      model: editing.model,
      apiKey: editing.apiKey.trim() || undefined
    })
    setBusy(false)
    if (res.ok) {
      setEditing(null)
      await refresh()
    } else {
      setError(res.error ?? '保存失败')
    }
  }

  const importAll = async (): Promise<void> => {
    setError('')
    const res = await window.cobrowse.agentImportOpencode()
    if (!res.ok) setError(res.error ?? '导入失败')
    await refresh()
  }

  const canSave =
    !!editing && editing.baseUrl.trim().length > 0 && editing.model.trim().length > 0

  return (
    <div className="providers-panel">
      <div className="providers-head">
        <span>模型配置</span>
        <span className="dim">{providers.length} 个</span>
        <button className="panel-collapse" title="关闭配置" onClick={onClose}>
          »
        </button>
      </div>

      <div className="providers-list">
        {providers.length === 0 && (
          <div className="providers-empty">还没有配置 — 可以「从 opencode 导入」或「新建」</div>
        )}
        {providers.map((p) => (
          <div
            key={p.id}
            className={`provider-item ${activeId === p.id ? 'on' : ''}`}
            onClick={() => {
              if (!editing) void activate(p.id)
            }}
            title={activeId === p.id ? '当前使用中' : '点击切换使用'}
          >
            <div className="provider-info">
              <div className="provider-name">
                {p.name}
                {activeId === p.id && <span className="provider-tag">使用中</span>}
              </div>
              <div className="provider-sub">
                {p.model || '未填模型'} · {hostOf(p.baseUrl)}
              </div>
            </div>
            <button
              className="provider-mini"
              title="编辑"
              onClick={(e) => {
                e.stopPropagation()
                setEditing({ id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: '' })
              }}
            >
              ✎
            </button>
            <button
              className={`provider-mini ${confirmDel === p.id ? 'danger' : ''}`}
              title="删除"
              onClick={(e) => {
                e.stopPropagation()
                void remove(p.id)
              }}
            >
              {confirmDel === p.id ? '确认' : '✕'}
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <div className="agent-form">
          <label>
            <span>名称</span>
            <input
              value={editing.name}
              placeholder="DeepSeek"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </label>
          <label>
            <span>Base URL</span>
            <input
              value={editing.baseUrl}
              spellCheck={false}
              placeholder="https://api.deepseek.com/v1"
              onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
            />
          </label>
          <label>
            <span>模型名</span>
            <input
              value={editing.model}
              spellCheck={false}
              placeholder="deepseek-chat"
              onChange={(e) => setEditing({ ...editing, model: e.target.value })}
            />
          </label>
          <label>
            <span>API Key</span>
            <input
              type="password"
              value={editing.apiKey}
              spellCheck={false}
              placeholder={editing.id ? '已保存 · 留空保持不变' : '本地服务（如 Ollama）可留空'}
              onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
            />
          </label>
          <div className="agent-form-row">
            <button className="import-btn" onClick={() => setEditing(null)}>
              取消
            </button>
            <button className="send-btn" disabled={!canSave || busy} onClick={() => void saveEdit()}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}

      {!editing && (
        <div className="provider-actions">
          <button onClick={() => setEditing({ name: '', baseUrl: '', model: '', apiKey: '' })}>
            ＋ 新建
          </button>
          <button onClick={() => void importAll()}>↓ 从 opencode 导入</button>
        </div>
      )}

      {error && <div className="agent-form-err providers-err">{error}</div>}
    </div>
  )
}
