import { useState } from 'react'
import { useI18n } from '../i18n'
import { ProvidersPanel } from './ProvidersPanel'
import { SitePermissionsPanel } from './SitePermissionsPanel'
import { SkillsPanel } from './SkillsPanel'
import { TimelinePanel } from './TimelinePanel'
import './model-access.css'

type Tab = 'providers' | 'sites' | 'skills' | 'timeline'

/**
 * 「模型与授权」：把原先三个并列入口（模型配置 / 站点授权 / 技能）合成一个面板。
 *
 * 为什么合并：侧栏头部一度有 6 个图标按钮，用户找不到东西；而这三件事在语义上
 * 都属于"AI 能用什么、能去哪里"，放在一起才讲得通。
 *
 * 为什么模型**选择**不在这里：切换模型是高频动作，不该每次都展开面板——
 * 它单独放在侧栏头部的下拉里。
 */
export function ModelAccessPanel({
  onClose,
  onChanged
}: {
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('providers')

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'providers', label: t('panel.modelConfig') },
    { id: 'sites', label: t('perm.settings.title') },
    { id: 'skills', label: t('panel.skillsCli') },
    // 时间线也是"AI 做了什么"的治理面，和授权放同一处，头部少一个按钮
    { id: 'timeline', label: t('timeline.title') }
  ]

  return (
    <div className="map">
      <div className="map-head">
        <strong className="map-title">{t('panel.modelAccess')}</strong>
        <button className="map-close" onClick={onClose} title={t('common.close')}>
          ✕
        </button>
      </div>

      <div className="map-tabs" role="tablist">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? 'map-tab on' : 'map-tab'}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="map-body">
        {tab === 'providers' && <ProvidersPanel embedded onClose={onClose} onChanged={onChanged} />}
        {tab === 'sites' && <SitePermissionsPanel embedded onClose={onClose} />}
        {tab === 'skills' && <SkillsPanel embedded onClose={onClose} />}
        {tab === 'timeline' && <TimelinePanel onClose={onClose} />}
      </div>
    </div>
  )
}
