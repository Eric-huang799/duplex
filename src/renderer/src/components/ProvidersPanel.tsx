import { useEffect, useState } from 'react'
import { LLM_PROTOCOLS, PROTOCOL_LABELS, type LlmProtocol } from '../../../shared/llm'

type AuthType = 'key' | 'import'
type AuthSource = 'codex' | 'opencode'

interface MaskedProvider {
  id: string
  name: string
  baseUrl: string
  model: string
  hasKey: boolean
  protocol: LlmProtocol
  authType: AuthType
  authSource?: AuthSource
}

interface EditingState {
  id?: string
  name: string
  baseUrl: string
  model: string
  apiKey: string
  protocol: LlmProtocol
  authType: AuthType
  authSource?: AuthSource
}

const PROTOCOL_SHORT: Record<LlmProtocol, string> = {
  'openai-chat': 'OpenAI 兼容',
  'anthropic-messages': 'Anthropic',
  'openai-responses': 'Responses',
  gemini: 'Gemini'
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
  const [confirmDel, setConfirmDel] = useState<{ id: string; stage: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [importInfo, setImportInfo] = useState<{
    found: boolean
    providers: string[]
    expiresAt?: number
    error?: string
  } | null>(null)

  const checkImport = async (source: AuthSource): Promise<void> => {
    setImportInfo(null)
    const s = await window.cobrowse.agentImportStatus(source)
    setImportInfo(s)
  }

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
    if (!confirmDel || confirmDel.id !== id) {
      setConfirmDel({ id, stage: 1 })
      setTimeout(() => setConfirmDel((c) => (c && c.id === id ? null : c)), 4000)
      return
    }
    if (confirmDel.stage === 1) {
      setConfirmDel({ id, stage: 2 })
      return
    }
    setConfirmDel(null)
    await window.cobrowse.agentProviderRemove(id)
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
      protocol: editing.protocol,
      authType: editing.authType,
      authSource: editing.authType === 'import' ? (editing.authSource ?? 'codex') : undefined,
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
                {p.protocol !== 'openai-chat' && ` · ${PROTOCOL_SHORT[p.protocol]}`}
                {p.authType === 'import' && ` · 导入:${p.authSource ?? '?'}`}
              </div>
            </div>
            <button
              className="provider-mini"
              title="编辑"
              onClick={(e) => {
                e.stopPropagation()
                setEditing({
                  id: p.id,
                  name: p.name,
                  baseUrl: p.baseUrl,
                  model: p.model,
                  apiKey: '',
                  protocol: p.protocol,
                  authType: p.authType,
                  authSource: p.authSource
                })
              }}
            >
              ✎
            </button>
            <button
              className={`provider-mini ${confirmDel?.id === p.id ? 'danger' : ''}`}
              title="删除（需连续确认三次）"
              onClick={(e) => {
                e.stopPropagation()
                void remove(p.id)
              }}
            >
              {confirmDel?.id === p.id ? (confirmDel.stage === 1 ? '确认?' : '再确认!') : '✕'}
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
            <span>协议</span>
            <select
              value={editing.protocol}
              onChange={(e) => setEditing({ ...editing, protocol: e.target.value as LlmProtocol })}
            >
              {LLM_PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {PROTOCOL_LABELS[p]}
                </option>
              ))}
            </select>
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
            <span>认证方式</span>
            <select
              value={editing.authType}
              onChange={(e) => {
                const v = e.target.value as AuthType
                setImportInfo(null)
                const authSource = v === 'import' ? (editing.authSource ?? 'codex') : undefined
                setEditing({ ...editing, authType: v, authSource })
                if (v === 'import') void checkImport(authSource ?? 'codex')
              }}
            >
              <option value="key">API Key</option>
              <option value="import">从本机 CLI 导入凭据</option>
            </select>
          </label>
          {editing.authType === 'import' ? (
            <label>
              <span>凭据来源</span>
              <select
                value={editing.authSource ?? 'codex'}
                onChange={(e) => {
                  const v = e.target.value as AuthSource
                  setEditing({ ...editing, authSource: v })
                  void checkImport(v)
                }}
              >
                <option value="codex">Codex（ChatGPT 订阅登录）</option>
                <option value="opencode">opencode 登录凭据</option>
              </select>
            </label>
          ) : (
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
          )}
          {editing.authType === 'import' && importInfo && (
            <div className="import-status">
              {importInfo.error
                ? importInfo.error
                : importInfo.found
                  ? `已找到：${importInfo.providers.join('、') || '（无可用条目）'}${
                      importInfo.expiresAt
                        ? ` · 有效期至 ${new Date(importInfo.expiresAt).toLocaleString()}`
                        : ''
                    }`
                  : '未找到本机凭据文件'}
            </div>
          )}
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
          <button
            onClick={() =>
              setEditing({
                name: '',
                baseUrl: '',
                model: '',
                apiKey: '',
                protocol: 'openai-chat',
                authType: 'key'
              })
            }
          >
            ＋ 新建
          </button>
          <button onClick={() => void importAll()}>↓ 从 opencode 导入</button>
        </div>
      )}

      {error && <div className="agent-form-err providers-err">{error}</div>}
    </div>
  )
}
