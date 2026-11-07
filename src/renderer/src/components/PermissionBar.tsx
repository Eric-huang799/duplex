import { useI18n } from '../i18n'
import type { I18nKey } from '../../../shared/i18n'
import type { PermissionAnswer, PermissionAskRequest } from '../../../shared/permissions'
import './permission-bar.css'

interface Props {
  request: PermissionAskRequest
  onAnswer: (id: number, answer: PermissionAnswer) => void
}

/**
 * 站点权限提示条（浏览器 chrome，不是页面里的元素）。
 *
 * 安全约束：**只显示主进程算出来的 origin**。渲染层拿不到也不该自己推断
 * "这条提示代表谁"，回传时也只带一个答案，origin/类别以主进程那份为准——
 * 否则页面就能伪造一条"请允许 example.com 使用摄像头"。
 */
export function PermissionBar({ request, onAnswer }: Props): React.JSX.Element {
  const { t } = useI18n()
  // 主进程给的是字面 key（跨进程传不了类型），这里按字典查
  const what = t(request.labelKey as I18nKey)

  return (
    <div className="perm-bar" role="dialog" aria-live="polite" aria-label={request.origin}>
      <span className={request.tier === 'high-risk' ? 'perm-bar-dot warn' : 'perm-bar-dot'} />
      <span className="perm-bar-text">
        {t('perm.bar.title', { origin: request.origin, what })}
        {request.topOrigin && request.topOrigin !== request.origin && (
          <span className="perm-bar-note">
            {t('perm.bar.fromFrame', { top: request.topOrigin })}
          </span>
        )}
      </span>
      <span className="perm-bar-actions">
        <button className="perm-btn primary" onClick={() => onAnswer(request.id, 'allow-session')}>
          {t('perm.bar.allowOnce')}
        </button>
        <button className="perm-btn" onClick={() => onAnswer(request.id, 'allow')}>
          {t('perm.bar.allowAlways')}
        </button>
        <button className="perm-btn ghost" onClick={() => onAnswer(request.id, 'deny')}>
          {t('perm.bar.deny')}
        </button>
      </span>
    </div>
  )
}
