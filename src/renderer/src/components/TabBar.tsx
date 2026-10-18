import { useEffect, useRef } from 'react'
import type { TabInfo } from '../../../shared/protocol'
import { useI18n } from '../i18n'

interface Props {
  tabs: TabInfo[]
  activeTabId: number | null
  onSwitch: (id: number) => void
  onClose: (id: number) => void
  onNew: () => void
  onNewIncognito: () => void
}

function shortTitle(tab: TabInfo, fallback: string): string {
  if (!tab.url || tab.url === 'about:blank') return fallback
  const s = tab.title || tab.url || fallback
  const clean = s.replace(/^https?:\/\/(www\.)?/, '')
  return clean.length > 22 ? clean.slice(0, 22) + '…' : clean
}

export function TabBar({ tabs, activeTabId, onSwitch, onClose, onNew, onNewIncognito }: Props): React.JSX.Element {
  const { t } = useI18n()
  const barRef = useRef<HTMLDivElement>(null)

  // keep the active tab visible when tabs overflow
  useEffect(() => {
    const el = barRef.current?.querySelector<HTMLElement>('.tab.active')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])

  return (
    <div
      className="tabbar"
      ref={barRef}
      onDoubleClick={onNew}
      onWheel={(e) => {
        const el = barRef.current
        if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY
      }}
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
          onClick={() => onSwitch(tab.id)}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onClose(tab.id)
            }
          }}
          title={tab.url}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            window.cobrowse.showTabContextMenu(tab.id, e.clientX, e.clientY)
          }}
        >
          {tab.loading && <span className="tab-loading" />}
          {tab.favicon && <img className="tab-favicon" src={tab.favicon} onError={(e) => { e.currentTarget.style.display = 'none' }} />}
          {(tab.audioMuted || tab.audioPlaying) && (
            <button
              className="tab-audio"
              title={tab.audioMuted ? t('tab.unmute') : t('tab.mute')}
              onClick={(e) => {
                e.stopPropagation()
                void window.cobrowse.tabAction({ type: 'toggleMute', tabId: tab.id })
              }}
            >
              {tab.audioMuted ? '🔇' : '🔊'}
            </button>
          )}
          <span className="tab-title">
            {tab.incognito && (
              <span style={{ fontSize: 10, marginRight: 3 }} title={t('tab.incognitoTitle')}>
                🕶
              </span>
            )}
            {shortTitle(tab, t('tab.new'))}
          </span>
          <button
            className="tab-close"
            title={t('tab.close')}
            onClick={(e) => {
              e.stopPropagation()
              onClose(tab.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button className="tab-new" onClick={onNew} onDoubleClick={(e) => e.stopPropagation()} title={t('tab.new')}>
        +
      </button>
      <button
        className="tab-new"
        onClick={onNewIncognito}
        onDoubleClick={(e) => e.stopPropagation()}
        title={t('tab.newIncognito')}
      >
        🕶
      </button>
    </div>
  )
}
