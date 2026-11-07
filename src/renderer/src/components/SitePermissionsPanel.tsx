import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import type { I18nKey } from '../../../shared/i18n'
import { metaOf, type Decision, type PermissionCategory } from '../../../shared/permissions'
import './site-permissions.css'

interface OriginRuleView {
  origin: string
  decisions: Partial<Record<PermissionCategory, Decision>>
  source: string
  updatedAt: number
}

/**
 * 站点权限设置页：把 `permissions.json` 里记下的规则列出来，可逐条恢复默认，
 * 也可整站撤销或全部清除。
 *
 * 这是纯"查看 + 撤销"界面——放行只能通过提示条上的用户点击产生，
 * 以免有人误以为这里能绕过提问直接授权。
 */
export function SitePermissionsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const [origins, setOrigins] = useState<OriginRuleView[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await window.cobrowse.sitePermissions()
      setOrigins((data.origins as OriginRuleView[]) ?? [])
    } catch {
      setOrigins([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      setBusy(true)
      try {
        await action()
        await refresh()
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  const resetOne = (origin: string, category: string): void => {
    void run(() => window.cobrowse.sitePermissionRemove({ origin, category }))
  }
  const resetOrigin = (origin: string): void => {
    void run(() => window.cobrowse.sitePermissionRemove({ origin }))
  }
  const clearAll = (): void => {
    void run(() => window.cobrowse.sitePermissionsClear())
  }

  return (
    <div className="site-perm">
      <div className="site-perm-head">
        <span className="site-perm-title">{t('perm.settings.title')}</span>
        <span className="site-perm-actions">
          {origins.length > 0 && (
            <button className="site-perm-btn ghost" disabled={busy} onClick={clearAll}>
              {t('perm.settings.clearAll')}
            </button>
          )}
          <button className="site-perm-btn" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>

      {origins.length === 0 ? (
        <div className="site-perm-empty">{t('perm.settings.empty')}</div>
      ) : (
        <div className="site-perm-list">
          {origins.map((rule) => {
            const entries = Object.entries(rule.decisions) as Array<[PermissionCategory, Decision]>
            return (
              <div className="site-perm-row" key={rule.origin}>
                <div className="site-perm-origin">
                  <span className="site-perm-host">{rule.origin}</span>
                  <span
                    className={
                      rule.source === 'agent' ? 'site-perm-src agent' : 'site-perm-src'
                    }
                  >
                    {rule.source === 'agent'
                      ? t('perm.settings.fromAgent')
                      : t('perm.settings.fromUser')}
                  </span>
                </div>
                <div className="site-perm-chips">
                  {entries.map(([category, decision]) => (
                    <span className={`site-perm-chip ${decision}`} key={category}>
                      {t(metaOf(category).labelKey as I18nKey)}
                      <b>{t(`perm.dec.${decision}` as I18nKey)}</b>
                      <button
                        className="site-perm-x"
                        title={t('perm.settings.resetOne')}
                        disabled={busy}
                        onClick={() => resetOne(rule.origin, category)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <button
                  className="site-perm-btn ghost small"
                  disabled={busy}
                  onClick={() => resetOrigin(rule.origin)}
                >
                  {t('perm.settings.resetOrigin')}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
