import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // keep the active tab visible when tabs overflow
  useEffect(() => {
    const el = barRef.current?.querySelector<HTMLElement>('.tab.active')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])

  useEffect(() => {
    onChromeOverlayChange?.('tab-context', Boolean(menu))
    return () => onChromeOverlayChange?.('tab-context', false)
  }, [menu, onChromeOverlayChange])

  // Esc or a click anywhere outside the menu closes it.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // Keep the context menu inside the viewport.
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      setMenuPos(null)
      return
    }
    const rect = menuRef.current.getBoundingClientRect()
    const pad = 6
    setMenuPos({
      left: Math.max(pad, Math.min(menu.x, window.innerWidth - rect.width - pad)),
      top: Math.max(pad, Math.min(menu.y, window.innerHeight - rect.height - pad))
    })
  }, [menu])

  return (
    <div
      className="tabbar"
      ref={barRef}
      onClick={() => setMenu(null)}
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
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, id: t.id }) }}
        >
          {t.loading && <span className="tab-loading" />}
          {t.favicon && <img className="tab-favicon" src={t.favicon} onError={(e) => { e.currentTarget.style.display = 'none' }} />}
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
      {menu && <div
        ref={menuRef}
        className="tab-context-menu"
        style={{ left: menuPos?.left ?? menu.x, top: menuPos?.top ?? menu.y }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button onClick={() => { onContext('duplicateTab', menu.id); setMenu(null) }}>复制标签页</button>
        <button onClick={() => { onContext('closeOthers', menu.id); setMenu(null) }}>关闭其他标签页</button>
        <button onClick={() => { onContext('closeToRight', menu.id); setMenu(null) }}>关闭右侧标签页</button>
        <button onClick={() => { onContext('reopenClosed', menu.id); setMenu(null) }}>重新打开关闭的标签页</button>
      </div>}
    </div>
  )
}
