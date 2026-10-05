import { useCallback, useEffect, useRef, useState } from 'react'
import type { MirrorEvent, TabInfo } from '../../shared/protocol'
import { TabBar } from './components/TabBar'
import { Toolbar } from './components/Toolbar'
import { SidePanel, type PanelMode } from './components/SidePanel'
import { StartPage } from './components/StartPage'
import { BrowserPanel } from './components/BrowserPanel'
import type { BrowserDataSnapshot, DownloadRecord } from '../../shared/protocol'

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
  const [browserData, setBrowserData] = useState<BrowserDataSnapshot>({ bookmarks: [], history: [], downloads: [] })
  const [downloads, setDownloads] = useState<DownloadRecord[]>([])
  const [library, setLibrary] = useState<'bookmarks' | 'history' | 'downloads' | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [mirror, setMirror] = useState<MirrorEvent[]>([])
  const [localMsgs, setLocalMsgs] = useState<LocalMessage[]>([])
  const [panelWidth, setPanelWidth] = useState(400)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('duplex-ai-open') !== 'true')
  const [panelMode, setPanelMode] = useState<PanelMode>(() => {
    const saved = localStorage.getItem('duplex-panel-mode')
    return saved === 'agent' || saved === 'external' ? saved : 'opencode'
  })
  const [externalTool, setExternalTool] = useState<string>(
    () => localStorage.getItem('duplex-external-tool') ?? 'codex'
  )
  const [agentEvents, setAgentEvents] = useState<MirrorEvent[]>([])
  const [confirmReq, setConfirmReq] = useState<{
    id: number
    command: string
    cwd: string
    skill: string
  } | null>(null)
  const [stopKeys, setStopKeys] = useState<string[]>(['Escape', 'F2'])
  const [stopToast, setStopToast] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)
  const setChromeOverlay = useCallback((id: string, open: boolean) => {
    window.cobrowse.setChromeOverlay(id, open)
  }, [])

  useEffect(() => {
    setChromeOverlay('library', library !== null)
    return () => setChromeOverlay('library', false)
  }, [library, setChromeOverlay])

  useEffect(() => {
    setChromeOverlay('find', findOpen)
    return () => setChromeOverlay('find', false)
  }, [findOpen, setChromeOverlay])

  useEffect(() => {
    setChromeOverlay('agent-confirm', confirmReq !== null)
    return () => setChromeOverlay('agent-confirm', false)
  }, [confirmReq, setChromeOverlay])

  useEffect(() => {
    void window.cobrowse.ready().then((s) => {
      setTabs(s.tabs)
      setActiveTabId(s.activeTabId)
      setMirror(s.mirror)
    })
    void window.cobrowse.browserData().then((data) => setBrowserData(data))
    const offBrowserData = window.cobrowse.onBrowserData(setBrowserData)
    void window.cobrowse.downloadsList().then(setDownloads)
    const offDownloads = window.cobrowse.onDownloads(setDownloads)
    const offShortcut = window.cobrowse.onBrowserShortcut((action) => {
      if (action === 'focusAddress') window.dispatchEvent(new Event('duplex:focus-address'))
      if (action === 'bookmark') void toggleBookmark()
      if (action === 'find') setFindOpen(true)
    })
    // built-in agent stream (restored across panel reloads)
    void window.cobrowse.agentEvents().then((evs) => {
      if (Array.isArray(evs) && evs.length > 0) {
        // collapse by (kind, partID) — legacy logs may contain streaming snapshots
        setAgentEvents(
          (evs as MirrorEvent[]).reduce((acc, ev) => mergeMirror(acc, ev), [] as MirrorEvent[])
        )
      }
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
        void window.cobrowse.agentEvents().then((evs) =>
          setAgentEvents(
            (evs as MirrorEvent[]).reduce((acc, ev) => mergeMirror(acc, ev), [] as MirrorEvent[])
          )
        )
        return
      }
      setAgentEvents((prev) => mergeMirror(prev, ev))
    })
    const offConfirm = window.cobrowse.onAgentConfirm((req) => {
      setConfirmReq(req)
      // the main process auto-denies after 120s — clear the dialog to match
      const id = req.id
      setTimeout(() => {
        setConfirmReq((cur) => (cur && cur.id === id ? null : cur))
      }, 125_000)
    })
    return () => {
      offTabs()
      offMirror()
      offAgent()
      offConfirm()
      offDownloads()
      offShortcut()
      offBrowserData()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const key = e.key.toLowerCase()
      const editing = (e.target as HTMLElement | null)?.matches?.('input,textarea,[contenteditable="true"]')
      if (key === 'l') { e.preventDefault(); window.dispatchEvent(new Event('duplex:focus-address')) }
      else if (key === 't' && e.shiftKey) { e.preventDefault(); void window.cobrowse.tabAction({ type: 'reopenClosed' }) }
      else if (key === 't') { e.preventDefault(); void window.cobrowse.tabAction({ type: 'newTab' }) }
      else if (key === 'w' && tabs.length) { e.preventDefault(); void window.cobrowse.tabAction({ type: 'closeTab', tabId: activeTabId ?? undefined }) }
      else if (key === 'r') { e.preventDefault(); void window.cobrowse.tabAction({ type: 'reload' }) }
      else if (key === 'd') { e.preventDefault(); void toggleBookmark() }
      else if (key === 'f' && !editing) { e.preventDefault(); setFindOpen(true) }
      else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleTab(-1) }
      else if (e.key === 'Tab') { e.preventDefault(); cycleTab(1) }
    }
    const onEscape = (e: KeyboardEvent): void => { if (e.key === 'Escape' && findOpen) { setFindOpen(false); void window.cobrowse.tabAction({ type: 'find', url: '' }) } }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onEscape)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keydown', onEscape) }
  }, [tabs, activeTabId, browserData, findOpen])

  const cycleTab = (step: number): void => {
    if (!tabs.length) return
    const index = Math.max(0, tabs.findIndex((t) => t.id === activeTabId))
    const target = tabs[(index + step + tabs.length) % tabs.length]
    if (target) void window.cobrowse.tabAction({ type: 'switchTab', tabId: target.id })
  }

  const toggleBookmark = async (): Promise<void> => {
    if (!activeTab || !/^https?:\/\//i.test(activeTab.url)) return
    await window.cobrowse.bookmarkToggle({ url: activeTab.url, title: activeTab.title, favicon: activeTab.favicon })
    setBrowserData(await window.cobrowse.browserData())
  }

  useEffect(() => {
    void window.cobrowse.emergencyKeysGet().then((s) => {
      if (Array.isArray(s.keys) && s.keys.length > 0) setStopKeys(s.keys)
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!stopKeys.includes(e.key)) return
      // let the capture input in the hotkey settings dialog record keys instead
      const t = e.target as HTMLElement | null
      if (t?.closest?.('.stopkey-capture')) return
      if (t?.matches?.('input,textarea,[contenteditable="true"]')) return
      e.preventDefault()
      e.stopPropagation()
      // emergency stop: abort built-in agent, kill external children, take over
      void window.cobrowse.agentAbort()
      void window.cobrowse.agentsStop()
      window.cobrowse.emergencyTakeover()
      setStopToast('已急停：已中断当前任务并接管浏览器')
      window.setTimeout(() => setStopToast(''), 2600)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [stopKeys])

  const changeMode = (m: PanelMode): void => {
    setPanelMode(m)
    localStorage.setItem('duplex-panel-mode', m)
    if (m !== 'external') void window.cobrowse.agentsSetMirrorSource('opencode')
  }

  const changeExternalTool = (id: string): void => {
    setExternalTool(id)
    localStorage.setItem('duplex-external-tool', id)
    changeMode('external')
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
          onContext={(action, id) => void window.cobrowse.tabAction({ type: action, tabId: id })}
          onChromeOverlayChange={setChromeOverlay}
        />
        <Toolbar
          active={activeTab}
          onAction={(a, url) => void window.cobrowse.tabAction({ type: a, url })}
          onStopKeysChanged={(keys) => setStopKeys(keys)}
          bookmarked={browserData.bookmarks.some((b) => b.url === activeTab?.url)}
          onBookmark={() => void toggleBookmark()}
          onOpenLibrary={setLibrary}
          onToggleAI={() => { const next = !collapsed; setCollapsed(next); localStorage.setItem('duplex-ai-open', String(!next)) }}
          aiOpen={!collapsed}
          onChromeOverlayChange={setChromeOverlay}
        />
        <div className="content" ref={contentRef}>
          {showStartPage && (
            <StartPage
              onNavigate={(v) => void window.cobrowse.tabAction({ type: 'navigate', url: v })}
              bookmarks={browserData.bookmarks}
              history={browserData.history}
            />
          )}
          {!activeTab && !showStartPage && <div className="content-empty">没有打开的标签页</div>}
        </div>
        {library && <div className="library-overlay"><BrowserPanel
          section={library} data={browserData} downloads={downloads} onClose={() => setLibrary(null)}
          onNavigate={(url) => { setLibrary(null); void window.cobrowse.tabAction({ type: 'navigate', url }) }}
          onRemoveHistory={(url, visitedAt) => { void window.cobrowse.historyRemove(url, visitedAt).then(() => window.cobrowse.browserData()).then(setBrowserData) }}
          onClearHistory={() => { void window.cobrowse.historyClear().then(() => window.cobrowse.browserData()).then(setBrowserData) }}
          onCancelDownload={(id) => { void window.cobrowse.downloadsCancel(id) }}
          onClearDownloads={() => { void window.cobrowse.downloadsClear().then(() => window.cobrowse.downloadsList()).then(setDownloads) }}
          onOpenDownload={(id) => { void window.cobrowse.downloadsOpen(id) }}
          onRevealDownload={(id) => { void window.cobrowse.downloadsReveal(id) }}
        /></div>}
        {findOpen && <div className="findbar"><input autoFocus placeholder="在页面中查找" value={findText} onChange={(e) => { setFindText(e.target.value); void window.cobrowse.tabAction({ type: 'find', url: e.target.value }) }} onKeyDown={(e) => { if (e.key === 'Escape') setFindOpen(false); if (e.key === 'Enter') void window.cobrowse.tabAction({ type: 'find', url: findText }) }} /><button onClick={() => { setFindOpen(false); void window.cobrowse.tabAction({ type: 'find', url: '' }) }}>关闭</button></div>}
      </div>

      {collapsed ? (
        <button className="panel-expand" title="展开 AI 面板" onClick={() => { setCollapsed(false); localStorage.setItem('duplex-ai-open', 'true') }}>
          AI
        </button>
      ) : (
        <>
          <div className="panel-divider" onMouseDown={startDrag} />
          <SidePanel
            width={panelWidth}
            events={mirror}
            localMsgs={localMsgs}
            onSend={(t) => void send(t)}
          onCollapse={() => { setCollapsed(true); localStorage.setItem('duplex-ai-open', 'false') }}
            mode={panelMode}
            onModeChange={changeMode}
            agentEvents={agentEvents}
            externalTool={externalTool}
            onExternalToolChange={changeExternalTool}
          />
        </>
      )}

      {stopToast && <div className="stop-toast">{stopToast}</div>}

      {confirmReq && (
        <div className="confirm-overlay">
          <div className="confirm-box">
            <div className="confirm-title">AI 请求执行操作（{confirmReq.skill}）</div>
            <pre className="confirm-cmd">{confirmReq.command}</pre>
            <div className="confirm-cwd">工作目录：{confirmReq.cwd}</div>
            <div className="confirm-row">
              <button
                className="import-btn"
                onClick={() => {
                  void window.cobrowse.agentConfirmRespond(confirmReq.id, false)
                  setConfirmReq(null)
                }}
              >
                拒绝
              </button>
              <button
                className="send-btn"
                onClick={() => {
                  void window.cobrowse.agentConfirmRespond(confirmReq.id, true)
                  setConfirmReq(null)
                }}
              >
                允许执行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
