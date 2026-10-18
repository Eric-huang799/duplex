import { useEffect, useRef, useState } from 'react'
import { LLM_PROTOCOLS, PROTOCOL_LABELS, type LlmProtocol } from '../../../shared/llm'
import { hostOfUrl, isTrustedImportedHost } from '../../../shared/trusted-hosts'
import { useI18n } from '../i18n'

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
    model: 'deepseek-v4-flash'
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
  const { t } = useI18n()
  const protocolShort = (p: LlmProtocol): string =>
    p === 'openai-chat' ? t('providers.protocolOpenAI') : PROTOCOL_SHORT[p]
  const presetLabel = (preset: Preset): string =>
    preset.label === '本地 Ollama' ? t('providers.localOllamaLabel') : preset.label
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
  const rootRef = useRef<HTMLDivElement | null>(null)
  const editingRef = useRef<EditingState | null>(null)
  const onCloseRef = useRef(onClose)
  editingRef.current = editing
  onCloseRef.current = onClose

  useEffect(() => {
    return () => {
      if (delTimerRef.current != null) window.clearTimeout(delTimerRef.current)
    }
  }, [])

  // Clicking outside collapses the panel. An open edit form is dismissed
  // first, so a stray click cannot silently discard typed values in one step.
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (target && (rootRef.current?.contains(target) || target.closest('[data-panel-toggle="providers"]'))) return
      if (editingRef.current) {
        setEditing(null)
        return
      }
      onCloseRef.current()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
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
        setError(res.error ?? t('providers.saveFailed'))
      }
    } catch (e) {
      setError((e as Error)?.message ?? t('providers.saveFailed'))
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
        setError(res.error ?? t('providers.clearFailed'))
        return
      }
      setEditing((cur) => (cur ? { ...cur, hasKey: false, apiKey: '' } : cur))
      await refresh()
    } catch (e) {
      setError((e as Error)?.message ?? t('providers.clearFailed'))
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
      if (!res.ok) setError(res.error ?? t('providers.importFailed'))
      await refresh()
    } catch (e) {
      setError((e as Error)?.message ?? t('providers.importFailed'))
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
    <div className="providers-panel" ref={rootRef}>
      <div className="providers-head">
        <span>{t('providers.title')}</span>
        <span className="dim">{t('providers.count', { n: providers.length })}</span>
        <button className="panel-collapse" title={t('providers.close')} onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="providers-list">

        {providers.length === 0 && (
          <>
            <div className="providers-empty">{t('providers.empty')}</div>
            {!editing && (
              <div className="provider-actions">
                {PRESETS.map((preset) => (
                  <button
                    key={presetLabel(preset)}
                    type="button"
                    title={t('providers.fillPreset', { url: preset.baseUrl, model: preset.model })}
                    onClick={() => applyPreset(preset)}
                  >
                    {presetLabel(preset)}
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
                ? t('providers.inUse')
                : confirmSwitch?.id === p.id
                  ? t('providers.confirmSwitch')
                  : t('providers.switchHint')
            }
          >
            <div className="provider-info">
              <div className="provider-name">
                {p.name}
                {activeId === p.id && <span className="provider-tag">{t('providers.inUseTag')}</span>}
              </div>
              <div className={`provider-sub ${confirmSwitch?.id === p.id ? 'confirm' : ''}`}>
                {confirmSwitch?.id === p.id
                  ? t('providers.confirmSwitch')
                  : <>
                      {p.model || t('providers.noModel')} · {hostOfUrl(p.baseUrl) || p.baseUrl}
                      {p.protocol !== 'openai-chat' && ` · ${protocolShort(p.protocol)}`}
                      {p.authType === 'import' && t('providers.importSuffix', { src: p.authSource ?? '?' })}
                    </>}
              </div>
            </div>
            <button
              className="provider-mini"
              title={t('lib.edit')}
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
              title={t('providers.deleteConfirm')}
              onClick={(e) => {
                e.stopPropagation()
                void remove(p.id)
              }}
            >
              {confirmDel?.id === p.id ? (confirmDel.stage === 1 ? t('panel.confirmOne') : t('panel.confirmAgain')) : '✕'}
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
                  key={presetLabel(preset)}
                  type="button"
                  title={t('providers.fillPreset', { url: preset.baseUrl, model: preset.model })}
                  onClick={() => applyPreset(preset)}
                >
                  {presetLabel(preset)}
                </button>
              ))}
            </div>
          )}
          <label>
            <span>{t('providers.name')}</span>
            <input
              value={editing.name}
              placeholder="DeepSeek"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </label>
          <label>
            <span>{t('providers.protocol')}</span>
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
            <span>{t('providers.modelName')}</span>
            <input
              value={editing.model}
              spellCheck={false}
              placeholder="deepseek-v4-flash"
              onChange={(e) => setEditing({ ...editing, model: e.target.value })}
            />
          </label>
          <label>
            <span>{t('providers.authType')}</span>
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
              <option value="import">{t('providers.importFromCli')}</option>
            </select>
          </label>
          {editing.authType === 'import' ? (
            <label>
              <span>{t('providers.credSource')}</span>
              <select
                value={editing.authSource ?? 'codex'}
                onChange={(e) => {
                  const v = e.target.value as AuthSource
                  setEditing({ ...editing, authSource: v })
                  void checkImport(v)
                }}
              >
                <option value="codex">{t('providers.codexLogin')}</option>
                <option value="opencode">{t('providers.opencodeCred')}</option>
              </select>
            </label>
          ) : (
            <label>
              <span>API Key</span>
              <input
                type="password"
                value={editing.apiKey}
                spellCheck={false}
                placeholder={editing.id ? t('providers.keyPlaceholderSaved') : t('providers.keyPlaceholderEmpty')}
                onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
              />
              {editing.id && editing.hasKey && (
                <button
                  type="button"
                  className="key-clear-btn"
                  disabled={busy}
                  title={t('providers.clearKeyTitle')}
                  onClick={() => void clearKey()}
                >
                  {t('providers.clearKey')}
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
                {t('providers.trustGateway', { host: hostOfUrl(editing.baseUrl) || editing.baseUrl.trim() || t('providers.baseUrlMissing') })}
              </span>
            </label>
          )}
          {editing.authType === 'import' && importInfo && (
            <div className="import-status">
              {importInfo.error
                ? importInfo.error
                : importInfo.found
                  ? t('providers.importFound', { list: importInfo.providers.join(', ') || t('providers.importNoEntries') }) + `${
                      importInfo.expiresAt
                        ? t('providers.importExpiry', { date: new Date(importInfo.expiresAt).toLocaleString() })
                        : ''
                    }`
                  : t('providers.importNotFound')}
            </div>
          )}
          <label>
            <span>{t('providers.idleTimeoutLabel')}</span>
            <input
              value={editing.idleTimeoutSec}
              spellCheck={false}
              inputMode="numeric"
              placeholder={t('providers.idleExample')}
              onChange={(e) => setEditing({ ...editing, idleTimeoutSec: e.target.value })}
            />
          </label>
          <div className="agent-form-row">
            <button className="import-btn" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
            <button className="send-btn" disabled={!canSave || busy} onClick={() => void saveEdit()}>
              {busy ? t('providers.saving') : t('common.save')}
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="providers-empty">
          {t('providers.ollamaHint')}
        </div>
      )}

      {!editing && (
        <div className="provider-actions">
          <button onClick={() => setEditing(newEditing())}>{t('providers.newProvider')}</button>
          <button
            className={importStage > 0 ? 'danger' : ''}
            onClick={() => void importAll()}
          >
            {importStage > 0 ? t('providers.confirmImport') : t('providers.importOpencode')}
          </button>
        </div>
      )}

      {error && <div className="agent-form-err providers-err">{error}</div>}
    </div>
  )
}
