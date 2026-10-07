import { useEffect, useRef, useState } from 'react'
import { LLM_PROTOCOLS, PROTOCOL_LABELS, type LlmProtocol } from '../../../shared/llm'
import { hostOfUrl, isTrustedImportedHost } from '../../../shared/trusted-hosts'

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
  idleTimeoutMs?: number
  allowCustomHost?: boolean
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
  hasKey?: boolean
  idleTimeoutSec: string
  allowCustomHost: boolean
}

const PROTOCOL_SHORT: Record<LlmProtocol, string> = {
  'openai-chat': 'OpenAI 兼容',
  'anthropic-messages': 'Anthropic',
  'openai-responses': 'Responses',
  gemini: 'Gemini'
}

interface Preset {
  label: string
  name: string
  baseUrl: string
  model: string
  clearKey?: boolean
}

/** One-click fill for common OpenAI-compatible endpoints (does not save). */
const PRESETS: Preset[] = [
  {
    label: 'DeepSeek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  },
  {
    label: 'OpenAI',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o'
  },
  {
    label: '本地 Ollama',
    name: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    clearKey: true
  }
]

function newEditing(): EditingState {
  return {
    name: '',
    baseUrl: '',
    model: '',
    apiKey: '',
    protocol: 'openai-chat',
    authType: 'key',
    idleTimeoutSec: '',
    allowCustomHost: false
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
  const [confirmSwitch, setConfirmSwitch] = useState<{ id: string; stage: number } | null>(null)
  const [importStage, setImportStage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [importInfo, setImportInfo] = useState<{
    found: boolean
    providers: string[]
    expiresAt?: number
    error?: string
  } | null>(null)
  const delTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (delTimerRef.current != null) window.clearTimeout(delTimerRef.current)
    }
  }, [])

  const applyPreset = (preset: Preset): void => {
    setImportInfo(null)
    setEditing((cur) => {
      const base = cur ?? newEditing()
      return {
        ...base,
        name: preset.name,
        baseUrl: preset.baseUrl,
        model: preset.model,
        protocol: 'openai-chat',
        authType: 'key',
        authSource: undefined,
        apiKey: preset.clearKey ? '' : base.apiKey
      }
    })
  }

  const checkImport = async (source: AuthSource): Promise<void> => {
    setImportInfo(null)
    const s = await window.cobrowse.agentImportStatus(source)
    setImportInfo(s)
  }

  const refresh = async (): Promise<void> => {
    const s = await window.cobrowse.agentProviders()
    setProviders(s.providers as MaskedProvider[])
    setActiveId(s.activeId)
    onChanged()
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc cancels the edit form.
  const editingOpen = editing !== null
  useEffect(() => {
    if (!editingOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setEditing(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editingOpen])

  const activate = async (id: string): Promise<void> => {
    await window.cobrowse.agentProviderActivate(id)
    await refresh()
  }

  /** Two-step inline confirm before switching the active provider. */
  const requestActivate = (id: string): void => {
    if (activeId === id) return
    if (!confirmSwitch || confirmSwitch.id !== id) {
      setConfirmSwitch({ id, stage: 1 })
      setTimeout(() => setConfirmSwitch((c) => (c && c.id === id ? null : c)), 4000)
      return
    }
    setConfirmSwitch(null)
    void activate(id)
  }

  const armDelReset = (id: string): void => {
    if (delTimerRef.current != null) window.clearTimeout(delTimerRef.current)
    delTimerRef.current = window.setTimeout(
      () => setConfirmDel((c) => (c && c.id === id ? null : c)),
      4000
    )
  }

  const remove = async (id: string): Promise<void> => {
    if (!confirmDel || confirmDel.id !== id) {
      setConfirmDel({ id, stage: 1 })
      armDelReset(id)
      return
    }
    if (confirmDel.stage === 1) {
      setConfirmDel({ id, stage: 2 })
      armDelReset(id)
      return
    }
    if (delTimerRef.current != null) {
      window.clearTimeout(delTimerRef.current)
      delTimerRef.current = null
    }
    setConfirmDel(null)
    await window.cobrowse.agentProviderRemove(id)
    await refresh()
  }

  const saveEdit = async (): Promise<void> => {
    if (!editing || busy) return
    setBusy(true)
    setError('')
    try {
      const sec = Number(editing.idleTimeoutSec.trim())
      const idleTimeoutMs =
        editing.idleTimeoutSec.trim() && Number.isFinite(sec) && sec > 0
          ? Math.round(sec) * 1000
          : undefined
      const customHost =
        editing.authType === 'import' &&
        !isTrustedImportedHost(editing.baseUrl, editing.authSource)
      const res = await window.cobrowse.agentProviderSave({
        id: editing.id,
        name: editing.name,
        baseUrl: editing.baseUrl,
        model: editing.model,
        protocol: editing.protocol,
        authType: editing.authType,
        authSource: editing.authType === 'import' ? (editing.authSource ?? 'codex') : undefined,
        apiKey: editing.apiKey.trim() || undefined,
        idleTimeoutMs,
        allowCustomHost: customHost ? editing.allowCustomHost : undefined
      })
      if (res.ok) {
        setEditing(null)
        await refresh()
      } else {
        setError(res.error ?? '保存失败')
      }
    } catch (e) {
      setError((e as Error)?.message ?? '保存失败')
    } finally {
      setBusy(false)
    }
  }

  /** Clear the stored key of an existing provider (keeps the provider itself). */
  const clearKey = async (): Promise<void> => {
    if (!editing?.id || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await window.cobrowse.agentProviderSave({ id: editing.id, clearApiKey: true })
      if (!res.ok) {
        setError(res.error ?? '清除失败')
        return
      }
      setEditing((cur) => (cur ? { ...cur, hasKey: false, apiKey: '' } : cur))
      await refresh()
    } catch (e) {
      setError((e as Error)?.message ?? '清除失败')
    } finally {
      setBusy(false)
    }
  }

  const importAll = async (): Promise<void> => {
    if (importStage === 0) {
      setImportStage(1)
      setTimeout(() => setImportStage(0), 4000)
      return
    }
    setImportStage(0)
    setError('')
    try {
      const res = await window.cobrowse.agentImportOpencode()
      if (!res.ok) setError(res.error ?? '导入失败')
      await refresh()
    } catch (e) {
      setError((e as Error)?.message ?? '导入失败')
    }
  }

  const canSave =
    !!editing && editing.baseUrl.trim().length > 0 && editing.model.trim().length > 0
  const showTrust =
    !!editing &&
    editing.authType === 'import' &&
    !isTrustedImportedHost(editing.baseUrl, editing.authSource)
  const isNewForm = !!editing && !editing.id

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
          <>
            <div className="providers-empty">还没有配置 — 可以「从 opencode 导入」或「新建」</div>
            {!editing && (
              <div className="provider-actions">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    title={`填入 ${preset.baseUrl} · ${preset.model}`}
                    onClick={() => applyPreset(preset)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {providers.map((p) => (
          <div
            key={p.id}
            className={`provider-item ${activeId === p.id ? 'on' : ''}`}
            onClick={() => {
              if (!editing) requestActivate(p.id)
            }}
            title={
              activeId === p.id
                ? '当前使用中'
                : confirmSwitch?.id === p.id
                  ? '再次点击确认切换'
                  : '点击切换使用（需二次确认）'
            }
          >
            <div className="provider-info">
              <div className="provider-name">
                {p.name}
                {activeId === p.id && <span className="provider-tag">使用中</span>}
              </div>
              <div className={`provider-sub ${confirmSwitch?.id === p.id ? 'confirm' : ''}`}>
                {confirmSwitch?.id === p.id
                  ? '再次点击确认切换'
                  : <>
                      {p.model || '未填模型'} · {hostOfUrl(p.baseUrl) || p.baseUrl}
                      {p.protocol !== 'openai-chat' && ` · ${PROTOCOL_SHORT[p.protocol]}`}
                      {p.authType === 'import' && ` · 导入:${p.authSource ?? '?'}`}
                    </>}
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
                  authSource: p.authSource,
                  hasKey: p.hasKey,
                  idleTimeoutSec: p.idleTimeoutMs && p.idleTimeoutMs > 0 ? String(Math.round(p.idleTimeoutMs / 1000)) : '',
                  allowCustomHost: !!p.allowCustomHost
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
          {isNewForm && (
            <div className="provider-actions">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  title={`填入 ${preset.baseUrl} · ${preset.model}`}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
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
              {editing.id && editing.hasKey && (
                <button
                  type="button"
                  className="key-clear-btn"
                  disabled={busy}
                  title="删除本机已保存的 API Key（提供商配置保留）"
                  onClick={() => void clearKey()}
                >
                  清除已保存的 Key
                </button>
              )}
            </label>
          )}
          {showTrust && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={editing.allowCustomHost}
                onChange={(e) => setEditing({ ...editing, allowCustomHost: e.target.checked })}
              />
              <span>
                我信任此网关：允许把导入的凭据发送到当前主机{' '}
                {hostOfUrl(editing.baseUrl) || editing.baseUrl.trim() || '（Base URL 未填写）'}
              </span>
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
          <label>
            <span>空闲超时（秒，留空使用默认）</span>
            <input
              value={editing.idleTimeoutSec}
              spellCheck={false}
              inputMode="numeric"
              placeholder="例如：120"
              onChange={(e) => setEditing({ ...editing, idleTimeoutSec: e.target.value })}
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

      {editing && (
        <div className="providers-empty">
          本地 Ollama 无需 API Key：先运行 ollama serve，Base URL 填 http://localhost:11434/v1
        </div>
      )}

      {!editing && (
        <div className="provider-actions">
          <button onClick={() => setEditing(newEditing())}>＋ 新建</button>
          <button
            className={importStage > 0 ? 'danger' : ''}
            onClick={() => void importAll()}
          >
            {importStage > 0 ? '确认导入？' : '↓ 从 opencode 导入'}
          </button>
        </div>
      )}

      {error && <div className="agent-form-err providers-err">{error}</div>}
    </div>
  )
}
