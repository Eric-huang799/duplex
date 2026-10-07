import { useCallback, useEffect, useRef, useState } from 'react'
import type { LoadErrorInfo, MirrorEvent, TabInfo } from '../../shared/protocol'
import { matchesBinding, parseBinding } from '../../shared/hotkeys'
import type { PermissionRequest } from './components/PermissionCard'
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

/** Last panel mode the user explicitly picked; null when never chosen. */
function savedPanelMode(): PanelMode | null {
  const saved = localStorage.getItem('duplex-panel-mode')
  return saved === 'agent' || saved === 'external' || saved === 'opencode' ? saved : null
}

interface EmergencyStopEvent {
  via?: string
  aborted?: boolean | number
  killed?: number
  dropped?: number
}

function emergencyStopText(s: EmergencyStopEvent): string {
  const ops = typeof s.aborted === 'number' ? s.aborted : null
  const killed = typeof s.killed === 'number' ? s.killed : null
  const dropped = typeof s.dropped === 'number' ? s.dropped : null
  if (ops == null && killed == null && dropped == null) return 'AI 操作已全部切断'
  const n = ops ?? (s.aborted === true ? 1 : 0)
  return `中断 ${n} 个操作、终止 ${killed ?? 0} 个外部进程、丢弃 ${dropped ?? 0} 条排队消息`
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
  const [panelMode, setPanelMode] = useState<PanelMode>(() => savedPanelMode() ?? 'agent')
  const [externalTool, setExternalTool] = useState<string>(
    () => localStorage.getItem('duplex-external-tool') ?? 'codex'
  )
  const [agentEvents, setAgentEvents] = useState<MirrorEvent[]>([])
  const [confirms, setConfirms] = useState<PermissionRequest[]>([])
  const [stopKeys, setStopKeys] = useState<string[]>(['F2', 'Ctrl+Shift+K'])
  const [stopToast, setStopToast] = useState('')
  const [toast, setToast] = useState('')
  const [findResult, setFindResult] = useState<{ matches: number; activeMatch: number } | null>(null)
  const [loadError, setLoadError] = useState<LoadErrorInfo | null>(null)
  const [annotationActive, setAnnotationActive] = useState(false)
  const [aiPaused, setAiPaused] = useState(false)
  const [providersChecked, setProvidersChecked] = useState(() => savedPanelMode() !== null)
  const [initialShowProviders, setInitialShowProviders] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const toggleBookmarkRef = useRef<() => void>(() => {})
  const downloadsRef = useRef<DownloadRecord[]>([])
  const downloadsLoadedRef = useRef(false)
  const toastTimerRef = useRef<number | null>(null)
  const stopToastTimerRef = useRef<number | null>(null)
  const loadErrTimerRef = useRef<number | null>(null)
  const pausedRef = useRef(false)
  const setChromeOverlay = useCallback((id: string, open: boolean) => {
    window.cobrowse.setChromeOverlay(id, open)
  }, [])

  const closeFind = useCallback((): void => {
    setFindOpen(false)
    setFindText('')
    setFindResult(null)
    void window.cobrowse.tabAction({ type: 'find', url: '' })
  }, [])

  const toggleAI = useCallback((): void => {
    setCollapsed((prev) => {
      const next = !prev
      localStorage.setItem('duplex-ai-open', String(!next))
      return next
    })
  }, [])

  const showToast = useCallback((text: string, ms = 3600): void => {
    setToast(text)
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null
      setToast('')
    }, ms)
  }, [])

  const applyDownloads = useCallback(
    (rows: DownloadRecord[], initial = false): void => {
      if (!initial && downloadsLoadedRef.current) {
        const prev = new Map(downloadsRef.current.map((d) => [d.id, d] as const))
        for (const row of rows) {
          const before = prev.get(row.id)
          if (row.state === 'completed' && before?.state !== 'completed') {
            showToast(`下载完成：${row.filename}`)
          } else if (row.state === 'interrupted' && before?.state !== 'interrupted') {
            showToast(`下载中断：${row.filename}`)
          }
        }
      }
      downloadsLoadedRef.current = true
      downloadsRef.current = rows
      setDownloads(rows)
    },
    [showToast]
  )

  const navigate = useCallback(
    (url: string): void => {
      void window.cobrowse.tabAction({ type: 'navigate', url }).then((r) => {
        const res = r as { ok?: boolean; error?: string } | undefined
        if (res && res.ok === false) showToast(res.error || '导航失败')
      })
    },
    [showToast]
  )

  const newTab = useCallback((): void => {
    void window.cobrowse.tabAction({ type: 'newTab' }).then(() => {
      window.setTimeout(() => window.dispatchEvent(new Event('duplex:focus-address')), 0)
    })
  }, [])

  const findNext = useCallback((): void => {
    if (!findText) return
    void window.cobrowse.tabAction({ type: 'findNext', url: findText })
  }, [findText])

  const findPrev = useCallback((): void => {
    if (!findText) return
    void window.cobrowse.tabAction({ type: 'findPrev', url: findText })
  }, [findText])

  const respondConfirm = useCallback((id: number, ok: boolean): void => {
    void window.cobrowse.agentConfirmRespond(id, ok)
    setConfirms((prev) =>
      prev.map((c) => (c.id === id ? { ...c, state: ok ? 'allowed' : 'denied' } : c))
    )
  }, [])

  useEffect(() => {
    setChromeOverlay('library', library !== null)
    return () => setChromeOverlay('library', false)
  }, [library, setChromeOverlay])

  useEffect(() => {
    void window.cobrowse.ready().then((s) => {
      setTabs(s.tabs)
      setActiveTabId(s.activeTabId)
      setMirror(s.mirror)
    })
    void window.cobrowse.browserData().then((data) => setBrowserData(data))
    const offBrowserData = window.cobrowse.onBrowserData(setBrowserData)
    void window.cobrowse.downloadsList().then((rows) => applyDownloads(rows, true))
    const offDownloads = window.cobrowse.onDownloads((rows) => applyDownloads(rows))
    const offFindResult = window.cobrowse.onFindResult((r) => setFindResult(r))
    const offAnnotation = window.cobrowse.onAnnotationState(setAnnotationActive)
    const offLoadError = window.cobrowse.onLoadError((info) => {
      setLoadError(info)
      if (loadErrTimerRef.current != null) window.clearTimeout(loadErrTimerRef.current)
      loadErrTimerRef.current = window.setTimeout(() => {
        loadErrTimerRef.current = null
        setLoadError(null)
      }, 8000)
    })
    const offShortcut = window.cobrowse.onBrowserShortcut((action) => {
      if (action === 'focusAddress') window.dispatchEvent(new Event('duplex:focus-address'))
      if (action === 'bookmark') toggleBookmarkRef.current()
      if (action === 'find') setFindOpen(true)
      if (action === 'togglePanel') toggleAI()
      if (action === 'annotationToggle') void window.cobrowse.annotationToggle()
      if (action === 'menu:library-bookmarks') setLibrary('bookmarks')
      if (action === 'menu:library-history') setLibrary('history')
      if (action === 'menu:library-downloads') setLibrary('downloads')
      if (action === 'menu:stopkeys') window.dispatchEvent(new Event('duplex:open-stopkeys'))
    })
    const onToast = (e: Event): void => {
      const detail = (e as CustomEvent).detail
      if (typeof detail === 'string' && detail) showToast(detail)
    }
    window.addEventListener('duplex:toast', onToast)
    // No explicit mode chosen yet: default to the built-in agent (opencode is
    // opt-in) and open the provider setup when nothing is configured.
    if (savedPanelMode() === null) {
      void window.cobrowse
        .agentProviders()
        .then((s) => {
          if (!(s.providers.length > 0 && s.activeId)) setInitialShowProviders(true)
        })
        .catch(() => setInitialShowProviders(true))
        .finally(() => setProvidersChecked(true))
    }
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
      setConfirms((prev) => {
        const next = [...prev.filter((c) => c.id !== req.id), { ...req, state: 'pending' as const }]
        return next.length > 20 ? next.slice(next.length - 20) : next
      })
      // a blocked run must never hide behind a collapsed panel
      setCollapsed(false)
      localStorage.setItem('duplex-ai-open', 'true')
    })
    const offConfirmCancel = window.cobrowse.onAgentConfirmCancel((s) => {
      setConfirms((prev) =>
        prev.map((c) => {
          if (c.state !== 'pending') return c
          if (s && s.id != null && c.id !== s.id) return c
          return { ...c, state: s && s.id != null ? ('expired' as const) : ('stopped' as const) }
        })
      )
    })
    return () => {
      offTabs()
      offMirror()
      offAgent()
      offConfirm()
      offConfirmCancel()
      offDownloads()
      offFindResult()
      offAnnotation()
      offLoadError()
      offShortcut()
      offBrowserData()
      window.removeEventListener('duplex:toast', onToast)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (e.altKey && !mod) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); void window.cobrowse.tabAction({ type: 'back' }) }
        else if (e.key === 'ArrowRight') { e.preventDefault(); void window.cobrowse.tabAction({ type: 'forward' }) }
        return
      }
      if (!mod || e.altKey) return
      const key = e.key.toLowerCase()
      const editing = (e.target as HTMLElement | null)?.matches?.('input,textarea,[contenteditable="true"]')
      if (key === 'l') { e.preventDefault(); window.dispatchEvent(new Event('duplex:focus-address')) }
      else if (key === 't' && e.shiftKey) { e.preventDefault(); void window.cobrowse.tabAction({ type: 'reopenClosed' }) }
      else if (key === 't') { e.preventDefault(); newTab() }
      else if (key === 'w' && !e.shiftKey && tabs.length) { e.preventDefault(); void window.cobrowse.tabAction({ type: 'closeTab', tabId: activeTabId ?? undefined }) }
      else if (key === 'r') { e.preventDefault(); void window.cobrowse.tabAction({ type: 'reload' }) }
      else if (key === 'd') { e.preventDefault(); void toggleBookmark() }
      else if (key === 'f' && !editing) { e.preventDefault(); setFindOpen(true) }
      else if (key === 'b' && !e.shiftKey && !editing) { e.preventDefault(); toggleAI() }
      else if (key === 'a' && e.shiftKey) { e.preventDefault(); void window.cobrowse.annotationToggle() }
      else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleTab(-1) }
      else if (e.key === 'Tab') { e.preventDefault(); cycleTab(1) }
      else if (/^[1-9]$/.test(key)) {
        e.preventDefault()
        const target = tabs[key === '9' ? tabs.length - 1 : Number(key) - 1]
        if (target) void window.cobrowse.tabAction({ type: 'switchTab', tabId: target.id })
      }
      else if (key === '=' || key === '+') { e.preventDefault(); void window.cobrowse.tabAction({ type: 'zoom', value: 0.5 }) }
      else if (key === '-' || key === '_') { e.preventDefault(); void window.cobrowse.tabAction({ type: 'zoom', value: -0.5 }) }
      else if (key === '0') { e.preventDefault(); void window.cobrowse.tabAction({ type: 'zoom', value: 0 }) }
    }
    const onEscape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (library) { setLibrary(null); return }
      if (findOpen) { closeFind(); return }
      const pending = [...confirms].reverse().find((c) => c.state === 'pending')
      if (pending) respondConfirm(pending.id, false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onEscape)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keydown', onEscape) }
  }, [tabs, activeTabId, browserData, findOpen, library, closeFind, toggleAI, newTab, confirms, respondConfirm])

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

  // keep the toolbar-shortcut callback pointing at the latest active tab
  useEffect(() => {
    toggleBookmarkRef.current = (): void => {
      void toggleBookmark()
    }
  })

  useEffect(() => {
    void window.cobrowse
      .emergencyKeysGet()
      .then((s) => {
        if (Array.isArray(s.keys) && s.keys.length > 0) setStopKeys(s.keys)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const binding = stopKeys.find((b) => matchesBinding(b, e))
      if (!binding) return
      // let the capture input in the hotkey settings dialog record keys instead
      const t = e.target as HTMLElement | null
      if (t?.closest?.('.stopkey-capture')) return
      // in an editable field a bare single key (F2) stays with the editor;
      // any combination with Ctrl/Alt/Shift/Meta still fires the emergency stop
      if (t?.matches?.('input,textarea,[contenteditable="true"]')) {
        const parsed = parseBinding(binding)
        if (!parsed || !(parsed.ctrl || parsed.alt || parsed.shift || parsed.meta)) return
      }
      e.preventDefault()
      e.stopPropagation()
      // emergency stop: the main process aborts in-flight operations, kills
      // external children and latches the AI off until the user resumes
      window.cobrowse.emergencyTakeover()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [stopKeys])

  useEffect(() => {
    const offState = window.cobrowse.onEmergencyState((s) => {
      const paused = !!s.paused
      setAiPaused(paused)
      if (!paused && pausedRef.current) showToast('AI 已恢复')
      pausedRef.current = paused
    })
    const offStop = window.cobrowse.onEmergencyStop((s) => {
      setStopToast(`已急停：${emergencyStopText(s)}`)
      if (stopToastTimerRef.current != null) window.clearTimeout(stopToastTimerRef.current)
      stopToastTimerRef.current = window.setTimeout(() => {
        stopToastTimerRef.current = null
        setStopToast('')
      }, 3600)
    })
    return () => {
      offState()
      offStop()
    }
  }, [showToast])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current)
      if (stopToastTimerRef.current != null) window.clearTimeout(stopToastTimerRef.current)
      if (loadErrTimerRef.current != null) window.clearTimeout(loadErrTimerRef.current)
    }
  }, [])

  // keep the main process aligned with the panel mode (including on startup)
  useEffect(() => {
    void window.cobrowse.setPanelMode(panelMode)
  }, [panelMode])

  // initialShowProviders is a first-mount hint only: drop it once the panel
  // actually rendered so collapsing/reopening does not reopen provider setup
  useEffect(() => {
    if (!collapsed && providersChecked && initialShowProviders) setInitialShowProviders(false)
  }, [collapsed, providersChecked, initialShowProviders])

  const changeMode = (m: PanelMode): void => {
    setPanelMode(m)
    localStorage.setItem('duplex-panel-mode', m)
    void window.cobrowse.agentsSetMirrorSource(m === 'external' ? 'external' : 'opencode')
  }

  const changeExternalTool = (id: string): void => {
    setExternalTool(id)
    localStorage.setItem('duplex-external-tool', id)
    changeMode('external')
  }

  // Remove optimistic local messages once the same user message arrives through
  // the mirror. A queued send can echo long after 60s, so the match never
  // expires; it only requires an echo that is not older than the send.
  useEffect(() => {
    let changed = false
    const remaining = localMsgs.filter((lm) => {
      const hit = mirror.some(
        (ev) =>
          ev.kind === 'text' &&
          ev.role === 'user' &&
          (ev.text ?? '').trim() === lm.text &&
          ev.ts >= lm.ts - 2000
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
    try {
      const res = await window.cobrowse.sendChat(text)
      if (!res.ok) {
        setLocalMsgs((prev) => prev.filter((m) => m.id !== lm.id))
        showToast('消息发送失败')
        return
      }
      if (res.warning) showToast('opencode 未连接：消息已排队')
    } catch {
      setLocalMsgs((prev) => prev.filter((m) => m.id !== lm.id))
      showToast('消息发送失败：无法连接主进程')
    }
  }

  return (
    <div className="app">
      <div className="left-col">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSwitch={(id) => void window.cobrowse.tabAction({ type: 'switchTab', tabId: id })}
          onClose={(id) => void window.cobrowse.tabAction({ type: 'closeTab', tabId: id })}
          onNew={newTab}
        />
        <Toolbar
          active={activeTab}
          onAction={(a, url) => {
            if (a === 'navigate' && url) navigate(url)
            else void window.cobrowse.tabAction({ type: a, url })
          }}
          onStopKeysChanged={(keys) => setStopKeys(keys)}
          bookmarked={browserData.bookmarks.some((b) => b.url === activeTab?.url)}
          onBookmark={() => void toggleBookmark()}
          onToggleAI={toggleAI}
          aiOpen={!collapsed}
          onChromeOverlayChange={setChromeOverlay}
          annotationActive={annotationActive}
          onToggleAnnotation={() => void window.cobrowse.annotationToggle()}
        />
        {findOpen && (
          <div className="findbar findbar-flow">
            <input
              autoFocus
              placeholder="在页面中查找"
              value={findText}
              onChange={(e) => {
                setFindText(e.target.value)
                void window.cobrowse.tabAction({ type: 'find', url: e.target.value })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (e.shiftKey) findPrev()
                  else findNext()
                }
              }}
            />
            <span className="find-count">
              {findResult ? `${findResult.activeMatch}/${findResult.matches}` : ''}
            </span>
            <button type="button" title="上一个" onClick={findPrev}>↑</button>
            <button type="button" title="下一个" onClick={findNext}>↓</button>
            <button type="button" onClick={closeFind}>关闭</button>
          </div>
        )}
        <div className="content" ref={contentRef}>
          {showStartPage && (
            <StartPage
              onNavigate={navigate}
              bookmarks={browserData.bookmarks}
              history={browserData.history}
            />
          )}
        </div>
        {library && <div className="library-overlay"><BrowserPanel
          section={library} data={browserData} downloads={downloads} onClose={() => setLibrary(null)}
          onNavigate={(url) => { setLibrary(null); navigate(url) }}
          onRemoveHistory={(url, visitedAt) => { void window.cobrowse.historyRemove(url, visitedAt).then(() => window.cobrowse.browserData()).then(setBrowserData) }}
          onClearHistory={() => { void window.cobrowse.historyClear().then(() => window.cobrowse.browserData()).then(setBrowserData) }}
          onCancelDownload={(id) => { void window.cobrowse.downloadsCancel(id) }}
          onClearDownloads={() => { void window.cobrowse.downloadsClear().then(() => window.cobrowse.downloadsList()).then((rows) => applyDownloads(rows, true)) }}
          onOpenDownload={(id) => { void window.cobrowse.downloadsOpen(id).then((r) => { if (!r.ok) showToast(r.error || '打开文件失败') }) }}
          onRevealDownload={(id) => { void window.cobrowse.downloadsReveal(id).then((r) => { if (!r.ok) showToast(r.error || '定位文件失败') }) }}
        /></div>}
      </div>

      {collapsed ? (
        <button className="panel-expand" title="展开 AI 面板" onClick={() => { setCollapsed(false); localStorage.setItem('duplex-ai-open', 'true') }}>
          AI
        </button>
      ) : (
        <>
          <div className="panel-divider" onMouseDown={startDrag} />
          {providersChecked && (
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
              confirms={confirms}
              onConfirmRespond={respondConfirm}
              initialShowProviders={initialShowProviders}
              onAgentSessionDeleted={() => setAgentEvents([])}
            />
          )}
        </>
      )}

      {(stopToast || toast || loadError) && (
        <div className="toast-stack">
          {stopToast && <div className="stop-toast">{stopToast}</div>}
          {toast && <div className="stop-toast">{toast}</div>}
          {loadError && (
            <div className="stop-toast" style={{ pointerEvents: 'auto' }}>
              页面加载失败：{loadError.desc}（{loadError.url}）
              <button
                style={{ pointerEvents: 'auto', marginLeft: 8, cursor: 'pointer' }}
                onClick={() => {
                  setLoadError(null)
                  void window.cobrowse.tabAction({ type: 'reload' })
                }}
              >
                重试
              </button>
            </div>
          )}
        </div>
      )}

      {aiPaused && (
        <div className="ai-paused-banner">
          <span className="ai-paused-dot" />
          <span>AI 已急停挂起 · 发消息或点「恢复」继续</span>
          <button onClick={() => window.cobrowse.resumeAi()}>恢复</button>
        </div>
      )}

      {confirms.some((c) => c.state === 'pending') && (
        <div className="sr-only" aria-live="polite">
          AI 请求执行操作，等待你的许可
        </div>
      )}
    </div>
  )
}
