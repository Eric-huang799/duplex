import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'

interface SkillInfo {
  id: string
  name: string
  description: string
  source: 'duplex' | 'claude'
  dir: string
  enabled: boolean
}

interface CodexStatus {
  found: boolean
  configured: boolean
  path: string
  backupPath?: string
}

/**
 * Skill manager + CLI integration entry: list/import/toggle skills, and set
 * up the MCP connection for Codex / Claude Code.
 */
export function SkillsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [codex, setCodex] = useState<CodexStatus | null>(null)
  const [claudeCmd, setClaudeCmd] = useState<{ command: string; hint: string; bridgeFound: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [delStage, setDelStage] = useState<{ id: string; stage: number } | null>(null)
  const [codexAsk, setCodexAsk] = useState(false)
  const [codexMsg, setCodexMsg] = useState('')
  const [copyMsg, setCopyMsg] = useState('')
  const delTimerRef = useRef<number | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const codexAskRef = useRef(false)
  const onCloseRef = useRef(onClose)
  codexAskRef.current = codexAsk
  onCloseRef.current = onClose

  useEffect(() => {
    return () => {
      if (delTimerRef.current != null) window.clearTimeout(delTimerRef.current)
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

  // Clicking outside collapses the panel; a pending Codex confirmation is
  // dismissed on the first outside click instead of losing both at once.
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (target && (rootRef.current?.contains(target) || target.closest('[data-panel-toggle="skills"]'))) return
      if (codexAskRef.current) {
        setCodexAsk(false)
        return
      }
      onCloseRef.current()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  useEffect(() => {
    if (!codexAsk) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCodexAsk(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [codexAsk])

  const refresh = async (): Promise<void> => {
    try {
      const s = (await window.cobrowse.skillsList()) as SkillInfo[]
      setSkills(Array.isArray(s) ? s : [])
      setCodex((await window.cobrowse.setupCodexStatus()) as CodexStatus)
    } catch (e) {
      setError((e as Error)?.message ?? t('skills.readFailed'))
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    if (togglingId) return
    setTogglingId(id)
    setError('')
    try {
      await window.cobrowse.skillsToggle(id, enabled)
      await refresh()
    } catch (e) {
      setError((e as Error)?.message ?? t('skills.toggleFailed'))
    } finally {
      setTogglingId(null)
    }
  }

  const armDelReset = (id: string): void => {
    if (delTimerRef.current != null) window.clearTimeout(delTimerRef.current)
    delTimerRef.current = window.setTimeout(
      () => setDelStage((c) => (c && c.id === id ? null : c)),
      4000
    )
  }

  const remove = async (id: string): Promise<void> => {
    if (!delStage || delStage.id !== id) {
      setError('')
      setDelStage({ id, stage: 1 })
      armDelReset(id)
      return
    }
    if (delStage.stage === 1) {
      setDelStage({ id, stage: 2 })
      armDelReset(id)
      return
    }
    if (delTimerRef.current != null) {
      window.clearTimeout(delTimerRef.current)
      delTimerRef.current = null
    }
    setDelStage(null)
    setError('')
    const r = await window.cobrowse.skillsRemove(id)
    if (!r.ok) setError(r.error ?? t('skills.deleteFailed'))
    await refresh()
  }

  const importFolder = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const r = await window.cobrowse.skillsImportFolder()
    setBusy(false)
    if (!r.ok && r.error !== '已取消' && r.error !== 'Canceled') setError(r.error ?? t('skills.importFailed'))
    await refresh()
  }

  const askInstallCodex = (): void => {
    if (!codex) return
    setError('')
    setCodexMsg('')
    setCodexAsk(true)
  }

  const confirmInstallCodex = async (): Promise<void> => {
    setCodexAsk(false)
    setError('')
    const r = await window.cobrowse.setupCodexInstall()
    if (!r.ok) {
      setError(r.error ?? t('skills.writeFailed'))
    } else if (r.backupPath) {
      setCodexMsg(t('skills.codexBackup', { path: r.backupPath }))
    } else {
      setCodexMsg(t('skills.codexFresh'))
    }
    await refresh()
  }

  const toggleClaude = async (): Promise<void> => {
    setCopyMsg('')
    if (claudeCmd) {
      setClaudeCmd(null)
      return
    }
    setError('')
    const r = await window.cobrowse.setupClaudeCommand()
    setClaudeCmd(r)
  }

  const copyClaudeCommand = async (): Promise<void> => {
    if (!claudeCmd) return
    try {
      await navigator.clipboard.writeText(claudeCmd.command)
      setCopyMsg(t('skills.copied'))
    } catch {
      setCopyMsg(t('skills.copyFailed'))
    }
    if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => setCopyMsg(''), 3000)
  }

  const duplexCount = skills.filter((s) => s.source === 'duplex').length
  const claudeCount = skills.filter((s) => s.source === 'claude').length

  return (
    <div className="providers-panel skills-panel" ref={rootRef}>
      <div className="providers-head">
        <span>Skills</span>
        <span className="dim">
          {t('skills.count', { n: skills.length, duplex: duplexCount, claude: claudeCount })}
        </span>
        <button className="panel-collapse" title={t('common.close')} onClick={onClose}>
          »
        </button>
      </div>

      <div className="providers-list">
        {skills.length === 0 && (
          <div className="providers-empty">{t('skills.empty')}</div>
        )}
        {skills.map((s) => (
          <div key={s.id} className="provider-item skill-item" title={s.dir}>
            <div className="provider-info">
              <div className="provider-name">
                {s.name}
                <span className="provider-tag">{s.source === 'duplex' ? t('skills.sourceDuplex') : 'Claude'}</span>
              </div>
              <div className="provider-sub skill-desc">{s.description || t('skills.noDesc')}</div>
            </div>
            <label
              className="skill-switch"
              title={s.enabled ? t('skills.enabled') : t('skills.disabled')}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={s.enabled}
                disabled={togglingId !== null}
                onChange={(e) => void toggle(s.id, e.target.checked)}
              />
            </label>
            {s.source === 'duplex' ? (
              <button
                className={`provider-mini ${delStage?.id === s.id ? 'danger' : ''}`}
                title={t('skills.deleteConfirm')}
                onClick={() => void remove(s.id)}
              >
                {delStage?.id === s.id ? (delStage.stage === 1 ? t('panel.confirmOne') : t('panel.confirmAgain')) : '✕'}
              </button>
            ) : (
              <span className="provider-mini skill-lock" title={t('skills.claudeSource')}>
                ·
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="provider-actions">
        <button disabled={busy} onClick={() => void importFolder()}>
          {t('skills.importFolder')}
        </button>
      </div>

      <div className="providers-head skills-subhead">
        <span>{t('skills.cli')}</span>
      </div>
      <div className="skills-integration">
        <div className="provider-sub" style={{ whiteSpace: 'normal' }}>
          {t('skills.injectedNote')}
        </div>
      </div>

      {error && (
        <div className="agent-form-err providers-err skill-err">
          <span>{error}</span>
          <button type="button" title={t('panel.clearError')} onClick={() => setError('')}>×</button>
        </div>
      )}
    </div>
  )
}
