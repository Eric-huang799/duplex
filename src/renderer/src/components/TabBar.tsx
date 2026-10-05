import { useEffect, useState } from 'react'
import type { TabInfo } from '../../../shared/protocol'

interface Props {
  tabs: TabInfo[]
  activeTabId: number | null
  onSwitch: (id: number) => void
  onClose: (id: number) => void
  onNew: () => void
  onContext: (action: string, id: number) => void
  onChromeOverlayChange?: (id: string, open: boolean) => void
}

function shortTitle(t: TabInfo): string {
  if (!t.url || t.url === 'about:blank') return '新标签页'
  const s = t.title || t.url || '新标签页'
  const clean = s.replace(/^https?:\/\/(www\.)?/, '')
  return clean.length > 22 ? clean.slice(0, 22) + '…' : clean
}

export function TabBar({ tabs, activeTabId, onSwitch, onClose, onNew, onContext, onChromeOverlayChange }: Props): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number; id: number } | null>(null)
  useEffect(() => {
    onChromeOverlayChange?.('tab-context', Boolean(menu))
    return () => onChromeOverlayChange?.('tab-context', false)
  }, [menu, onChromeOverlayChange])
  return (
    <div className="tabbar" onClick={() => setMenu(null)}>
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeTabId ? 'active' : ''}`}
          onClick={() => onSwitch(t.id)}
          title={t.url}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, id: t.id }) }}
        >
          {t.loading && <span className="tab-loading" />}
          {t.favicon && <img className="tab-favicon" src={t.favicon} />}
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
      <button className="tab-new" onClick={onNew} title="新建标签页">
        +
      </button>
      {menu && <div className="tab-context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
        <button onClick={() => { onContext('duplicateTab', menu.id); setMenu(null) }}>复制标签页</button>
        <button onClick={() => { onContext('closeOthers', menu.id); setMenu(null) }}>关闭其他标签页</button>
        <button onClick={() => { onContext('closeToRight', menu.id); setMenu(null) }}>关闭右侧标签页</button>
        <button onClick={() => { onContext('reopenClosed', menu.id); setMenu(null) }}>重新打开关闭的标签页</button>
      </div>}
    </div>
  )
}
