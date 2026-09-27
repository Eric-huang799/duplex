import { useEffect, useRef, useState } from 'react'
import type { MirrorEvent, TabInfo } from '../../shared/protocol'
import { TabBar } from './components/TabBar'
import { Toolbar } from './components/Toolbar'
import { SidePanel, type PanelMode } from './components/SidePanel'
import { StartPage } from './components/StartPage'

export interface LocalMessage {
  id: string
  text: string
  ts: number
}

function mergeMirror(prev: MirrorEvent[], ev: MirrorEvent): MirrorEvent[] {
  if (ev.kind === 'text' || ev.kind === 'reasoning' || ev.kind === 'tool') {
    const idx = prev.findIndex(
      (p) => p.kind === ev.kind && (p as { partID?: string }).partID === ev.partID
    )
    if (idx >= 0) {
      const next = prev.slice()
      next[idx] = ev
      return next
    }
  }
  const next = [...prev, ev]
  return next.length > 600 ? next.slice(next.length - 600) : next
}

export default function App(): React.JSX.Element {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const [mirror, setMirror] = useState<MirrorEvent[]>([])
  const [localMsgs, setLocalMsgs] = useState<LocalMessage[]>([])
  const [panelWidth, setPanelWidth] = useState(400)
  const [collapsed, setCollapsed] = useState(false)
  const [panelMode, setPanelMode] = useState<PanelMode>(() => {
    const saved = localStorage.getItem('duplex-panel-mode')
    return saved === 'agent' ? 'agent' : 'opencode'
  })
  const [agentEvents, setAgentEvents] = useState<MirrorEvent[]>([])
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.cobrowse.ready().then((s) => {
      setTabs(s.tabs)
      setActiveTabId(s.activeTabId)
      setMirror(s.mirror)
    })
    // built-in agent stream (restored across panel reloads)
    void window.cobrowse.agentEvents().then((evs) => {
      if (Array.isArray(evs) && evs.length > 0) setAgentEvents(evs)
    })
    const offTabs = window.cobrowse.onTabs((t, active) => {
      setTabs(t)
      setActiveTabId(active)
    })
    const offMirror = window.cobrowse.onMirror((ev) => {
      if (ev.kind === 'session-info' && ev.reason !== 'listed') {
        // session switched (select / create / restored): reset the stream so
        // the panel only shows the newly connected session's context
        setMirror([ev])
        setLocalMsgs([])
        return
      }
      setMirror((prev) => mergeMirror(prev, ev))
    })
    const offAgent = window.cobrowse.onAgent((ev) => {
      const info = (ev as { info?: string }).info
      if (info === 'reset' || info === 'switched') {
        // session created/switched: reload the full event log for that session
        void window.cobrowse.agentEvents().then((evs) => setAgentEvents(evs))
        return
      }
      setAgentEvents((prev) => mergeMirror(prev, ev))
    })
    return () => {
      offTabs()
      offMirror()
      offAgent()
    }
  }, [])

  const changeMode = (m: PanelMode): void => {
    setPanelMode(m)
    localStorage.setItem('duplex-panel-mode', m)
  }

  // Remove optimistic local messages once the same user message arrives through the mirror.
  useEffect(() => {
    let changed = false
    const remaining = localMsgs.filter((lm) => {
      const hit = mirror.some(
        (ev) =>
          ev.kind === 'text' &&
          ev.role === 'user' &&
          (ev.text ?? '').trim() === lm.text &&
          Math.abs(ev.ts - lm.ts) < 60_000
      )
      if (hit) changed = true
      return !hit
    })
    if (changed) setLocalMsgs(remaining)
  }, [mirror, localMsgs])

  // Report the web-content area to the main process (WebContentsView overlay).
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const report = (): void => {
      const r = el.getBoundingClientRect()
      window.cobrowse.setContentBounds({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [panelWidth, collapsed])

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const showStartPage = !activeTab || !activeTab.url || activeTab.url === 'about:blank'

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelWidth
    const onMove = (ev: MouseEvent): void => {
      const w = Math.min(Math.max(startW + (startX - ev.clientX), 280), 760)
      setPanelWidth(w)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const send = async (text: string): Promise<void> => {
    const lm: LocalMessage = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, ts: Date.now() }
    setLocalMsgs((prev) => [...prev, lm])
    await window.cobrowse.sendChat(text)
  }

  return (
    <div className="app">
      <div className="left-col">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSwitch={(id) => void window.cobrowse.tabAction({ type: 'switchTab', tabId: id })}
          onClose={(id) => void window.cobrowse.tabAction({ type: 'closeTab', tabId: id })}
          onNew={() => void window.cobrowse.tabAction({ type: 'newTab' })}
        />
        <Toolbar active={activeTab} onAction={(a, url) => void window.cobrowse.tabAction({ type: a, url })} />
        <div className="content" ref={contentRef}>
          {showStartPage && (
            <StartPage
              onNavigate={(v) => void window.cobrowse.tabAction({ type: 'navigate', url: v })}
            />
          )}
          {!activeTab && !showStartPage && <div className="content-empty">没有打开的标签页</div>}
        </div>
      </div>

      {collapsed ? (
        <button className="panel-expand" title="展开 AI 面板" onClick={() => setCollapsed(false)}>
          «
        </button>
      ) : (
        <>
          <div className="panel-divider" onMouseDown={startDrag} />
          <SidePanel
            width={panelWidth}
            events={mirror}
            localMsgs={localMsgs}
            onSend={(t) => void send(t)}
            onCollapse={() => setCollapsed(true)}
            mode={panelMode}
            onModeChange={changeMode}
            agentEvents={agentEvents}
          />
        </>
      )}
    </div>
  )
}
