import { useEffect, useRef } from 'react'
import type { TabInfo } from '../../../shared/protocol'

interface Props {
  tabs: TabInfo[]
  activeTabId: number | null
  onSwitch: (id: number) => void
  onClose: (id: number) => void
  onNew: () => void
}

function shortTitle(t: TabInfo): string {
  if (!t.url || t.url === 'about:blank') return '新标签页'
  const s = t.title || t.url || '新标签页'
  const clean = s.replace(/^https?:\/\/(www\.)?/, '')
  return clean.length > 22 ? clean.slice(0, 22) + '…' : clean
}

export function TabBar({ tabs, activeTabId, onSwitch, onClose, onNew }: Props): React.JSX.Element {
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
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeTabId ? 'active' : ''}`}
          onClick={() => onSwitch(t.id)}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onClose(t.id)
            }
          }}
          title={t.url}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            window.cobrowse.showTabContextMenu(t.id, e.clientX, e.clientY)
          }}
        >
          {t.loading && <span className="tab-loading" />}
          {t.favicon && <img className="tab-favicon" src={t.favicon} onError={(e) => { e.currentTarget.style.display = 'none' }} />}
          {(t.audioMuted || t.audioPlaying) && (
            <button
              className="tab-audio"
              title={t.audioMuted ? '取消静音' : '静音标签页'}
              onClick={(e) => {
                e.stopPropagation()
                void window.cobrowse.tabAction({ type: 'toggleMute', tabId: t.id })
              }}
            >
              {t.audioMuted ? '🔇' : '🔊'}
            </button>
          )}
          <span className="tab-title">{shortTitle(t)}</span>
          <button
            className="tab-close"
            title="关闭标签"
            onClick={(e) => {
              e.stopPropagation()
              onClose(t.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button className="tab-new" onClick={onNew} onDoubleClick={(e) => e.stopPropagation()} title="新建标签页">
        +
      </button>
    </div>
  )
}
