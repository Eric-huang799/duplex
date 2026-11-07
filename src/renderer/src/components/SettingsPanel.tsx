import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import './settings-panel.css'

interface AdblockStatus {
  enabled: boolean
  domains: number
  regex: number
  cosmetic: number
}

/**
 * 浏览器设置：用户侧唯一的调节面。
 *
 * 这里只放"用户自己也要能改"的东西——AI 能改的每一项，用户都必须有同样的开关，
 * 否则能力就不对称了。密码库不在此列（见 vault 的红线）。
 */
export function SettingsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const [adblock, setAdblock] = useState<AdblockStatus | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setAdblock(await window.cobrowse.settingsAdblockStatus())
    } catch {
      setAdblock(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggleAdblock = async (): Promise<void> => {
    if (!adblock || busy) return
    setBusy(true)
    try {
      const result = await window.cobrowse.settingsAdblockSet(!adblock.enabled)
      setNote(result.ok ? '' : (result.error ?? 'failed'))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const restore = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.cobrowse.settingsRestorePreAi()
      setNote(
        result.ok
          ? t('settings.restoreDone')
          : t('settings.restoreFailed', { err: result.error ?? '?' })
      )
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const rulesLine = adblock
    ? adblock.domains === 0 && adblock.regex === 0
      ? t('settings.adblockEmpty')
      : t('settings.adblockRules', { domains: adblock.domains, regex: adblock.regex })
    : ''

  return (
    <div className="setp">
      <div className="setp-head">
        <span className="setp-title">{t('settings.title')}</span>
        <button className="setp-btn" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="setp-row">
        <div className="setp-main">
          <div className="setp-label">{t('settings.adblock')}</div>
          <div className="setp-hint">{t('settings.adblockHint')}</div>
          {rulesLine && <div className="setp-hint">{rulesLine}</div>}
        </div>
        <button
          className={`setp-switch ${adblock?.enabled ? 'on' : ''}`}
          disabled={busy || !adblock}
          onClick={() => void toggleAdblock()}
        >
          {adblock?.enabled ? t('settings.on') : t('settings.off')}
        </button>
      </div>

      <div className="setp-row">
        <div className="setp-main">
          <div className="setp-label">{t('settings.restore')}</div>
          <div className="setp-hint">{t('settings.restoreHint')}</div>
        </div>
        <button className="setp-btn" disabled={busy} onClick={() => void restore()}>
          ↺
        </button>
      </div>

      {note && <div className="setp-note">{note}</div>}
    </div>
  )
}
