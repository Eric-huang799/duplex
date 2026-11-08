import { useI18n } from '../i18n'
import type { I18nKey } from '../../../shared/i18n'
import './permission-bar.css'
import './site-risk-bar.css'

export interface SiteRiskNotice {
  url: string
  level: 'notice' | 'warn'
  reasons: string[]
}

interface Props {
  notice: SiteRiskNotice
  onDismiss: () => void
}

const REASON_LABEL: Record<string, string> = {
  insecure: 'risk.insecure',
  'ip-host': 'risk.ipHost',
  punycode: 'risk.punycode',
  'credentials-in-url': 'risk.credentials',
  'unusual-port': 'risk.port',
  'long-host': 'risk.longHost',
  challenge: 'risk.challenge'
}

/**
 * 真人浏览的可疑站点预警条。
 *
 * 只提示、不拦截：用户点开什么都能看，我们只把**技术事实**摆出来。
 * 不做黑白名单，不说"这个站点不权威"——那是内容审查，不是这个浏览器的职责。
 */
export function SiteRiskBar({ notice, onDismiss }: Props): React.JSX.Element {
  const { t } = useI18n()
  let host = notice.url
  try {
    host = new URL(notice.url).origin
  } catch {
    /* keep the raw url */
  }

  return (
    <div
      className={`perm-bar site-risk ${notice.level === 'warn' ? 'warn' : ''}`}
      role="alert"
      aria-live="polite"
    >
      <span className={notice.level === 'warn' ? 'perm-bar-dot warn' : 'perm-bar-dot'} />
      <span className="perm-bar-text">
        {t('risk.title', { host })}
        <span className="perm-bar-note">
          {notice.reasons
            .map((reason) => t((REASON_LABEL[reason] ?? 'risk.unknown') as I18nKey))
            .join(' · ')}
        </span>
      </span>
      <span className="perm-bar-actions">
        <button className="perm-btn" onClick={onDismiss}>
          {t('risk.dismiss')}
        </button>
      </span>
    </div>
  )
}
