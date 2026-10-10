import { BrowserWindow, WebContentsView } from 'electron'
import type { ContentBounds, LoadErrorInfo, TabInfo } from '../shared/protocol'
import { matchesBinding } from '../shared/hotkeys'
import { DEFAULT_SHORTCUTS, type ShortcutAction } from '../shared/shortcuts'

export interface ConsoleEntry {
  level: string
  message: string
  ts: number
}

/** Fields the page context menu needs from Electron's `context-menu` event. */
export interface PageContextMenuInfo {
  /** Window coordinates (the page view's own offset is already applied). */
  x: number
  y: number
  linkURL: string
  srcURL: string
  mediaType: 'none' | 'image' | 'audio' | 'video' | 'canvas' | 'file' | 'plugin'
  selectionText: string
  isEditable: boolean
  editFlags: {
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
}

export interface Tab {
  id: number
  view: WebContentsView
  logs: ConsoleEntry[]
  favicon?: string
  /** Latest audibility reported by the tab's webContents. */
  audioPlaying?: boolean
}

/** A tab URL remembered for the "recently closed" list. */
export interface ClosedTabEntry {
  url: string
  title: string
}

export class TabManager {
  private tabs = new Map<number, Tab>()
  private nextId = 1
  activeId: number | null = null
  private closedTabs: ClosedTabEntry[] = []
  private chromeOverlays = new Set<string>()
  private bounds: ContentBounds = { x: 0, y: 88, width: 1200, height: 760 }
  private watchdog: ReturnType<typeof setInterval> | null = null
  private shortcutsMap: Record<ShortcutAction, string> = { ...DEFAULT_SHORTCUTS }

  constructor(
    private win: BrowserWindow,
    private overlayPreload: string | null,
    private onChanged: () => void,
    private onNavigate: (url: string, title: string, favicon?: string) => void,
    private onShortcut: (action: string) => void,
    private onMetadata: (url: string, title: string, favicon?: string) => void,
    private onLoadError?: (info: LoadErrorInfo) => void,
    private onFindResult?: (result: { tabId: number; matches: number; activeMatch: number }) => void,
    private onPageContextMenu?: (tab: Tab, info: PageContextMenuInfo) => void
  ) {
    // Chromium can leave a WebContentsView "hidden" (suspended rendering,
    // rAF stopped) after the window was minimized/occluded. Nudge the active
    // view back alive on window-state events, plus a periodic watchdog.
    this.win.on('show', () => this.activateView())
    this.win.on('restore', () => this.activateView())
    this.win.on('focus', () => this.activateView())
    this.watchdog = setInterval(() => void this.reviveActiveView(), 30_000)
    // the watchdog must never keep the process alive on its own
    this.watchdog.unref?.()
  }

  /** If the active view lost its visibility (Electron quirk after occlusion),
   *  re-kick it so Chromium resumes painting and rAF. */
  private async reviveActiveView(): Promise<void> {
    try {
      if (!this.win.isVisible() || this.win.isMinimized()) return
      const active = this.activeId != null ? this.tabs.get(this.activeId) : null
      if (!active || this.isBlank(active)) return
      const state = await active.view.webContents.executeJavaScript(
        'document.visibilityState',
        true
      )
      if (state === 'hidden') {
        active.view.setVisible(false)
        setTimeout(() => {
          // Always schedule the restore: while a chrome overlay (library /
          // find) is open the view stays hidden, but it must become visible
          // again once the overlay closes — never leave it stuck hidden.
          try {
            active.view.setVisible(
              this.chromeOverlays.size === 0 && this.activeId === active.id && !this.isBlank(active)
            )
            active.view.setBounds(this.bounds)
          } catch {
            /* view already torn down */
          }
        }, 80)
      }
    } catch {
      /* ignore */
    }
  }

  createTab(url?: string, options: { background?: boolean } = {}): Tab {
    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:cobrowse',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        ...(this.overlayPreload ? { preload: this.overlayPreload } : {})
      }
    })
    const tab: Tab = { id: this.nextId++, view, logs: [], audioPlaying: false }
    this.tabs.set(tab.id, tab)
    this.win.contentView.addChildView(view)
    view.setBounds(this.bounds)
    view.setVisible(false)
    this.wireEvents(tab)

    view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      if (openUrl && /^https?:/i.test(openUrl)) this.createTab(openUrl)
      return { action: 'deny' }
    })

    if (!options.background || this.activeId == null) this.setActive(tab.id)
    void view.webContents.loadURL(url ?? 'about:blank')
    this.emit()
    return tab
  }

  private wireEvents(tab: Tab): void {
    const wc = tab.view.webContents
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      // Ctrl+1..8 switch to the Nth tab, Ctrl+9 to the last one (fixed/reserved)
      if ((input.control || input.meta) && !input.alt && /^[1-9]$/.test(input.key)) {
        event.preventDefault()
        const ids = Array.from(this.tabs.keys())
        const target = input.key === '9' ? ids[ids.length - 1] : ids[Number(input.key) - 1]
        if (target != null) this.setActive(target)
        return
      }
      const like = {
        key: input.key,
        ctrlKey: input.control,
        altKey: input.alt,
        shiftKey: input.shift,
        metaKey: input.meta
      }
      let action: ShortcutAction | null = null
      for (const id of Object.keys(this.shortcutsMap) as ShortcutAction[]) {
        if (matchesBinding(this.shortcutsMap[id], like, process.platform)) {
          action = id
          break
        }
      }
      if (!action) return
      event.preventDefault()
      switch (action) {
        case 'closeTab':
          this.closeTab(tab.id)
          break
        case 'reload':
          wc.reload()
          break
        case 'newTab':
          this.createTab()
          break
        case 'reopenClosed':
          this.reopenClosed()
          break
        case 'zoomIn':
          wc.setZoomLevel(Math.min(5, wc.getZoomLevel() + 0.5))
          break
        case 'zoomOut':
          wc.setZoomLevel(Math.max(-5, wc.getZoomLevel() - 0.5))
          break
        case 'zoomReset':
          wc.setZoomLevel(0)
          break
        case 'back': {
          const nav = wc.navigationHistory
          if (nav.canGoBack()) nav.goBack()
          break
        }
        case 'forward': {
          const nav = wc.navigationHistory
          if (nav.canGoForward()) nav.goForward()
          break
        }
        default:
          // app-level shortcuts while the page has focus (mirrors the chrome UI);
          // the main-process handler still expects the legacy 'previousTab' name
          this.onShortcut(action === 'prevTab' ? 'previousTab' : action)
      }
    })
    const changed = (): void => {
      if (tab.id === this.activeId) this.activateView()
      this.emit()
    }
    wc.on('did-start-loading', changed)
    wc.on('did-stop-loading', changed)
    wc.on('did-navigate', changed)
    wc.on('did-navigate', (_event, url) => {
      tab.favicon = undefined
      this.onNavigate(url, wc.getTitle())
    })
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) this.onNavigate(url, wc.getTitle(), tab.favicon)
    })
    wc.on('page-favicon-updated', (_event, icons) => {
      tab.favicon = icons[0]
      this.onMetadata(wc.getURL(), wc.getTitle(), tab.favicon)
      changed()
    })
    wc.on('page-title-updated', (_event, title) => this.onMetadata(wc.getURL(), title, tab.favicon))
    wc.on('found-in-page', (_event, result) => {
      try {
        this.onFindResult?.({
          tabId: tab.id,
          matches: result.matches,
          activeMatch: result.activeMatchOrdinal
        })
      } catch {
        /* find-result reporting must never break the page */
      }
    })
    // Page right-click: forward the fields the app-level native menu needs.
    // params.x/y are relative to the page view; translate them into window
    // coordinates so Menu.popup lands under the actual cursor.
    wc.on('context-menu', (_event, params) => {
      if (!this.onPageContextMenu) return
      try {
        this.onPageContextMenu(tab, {
          x: params.x + this.bounds.x,
          y: params.y + this.bounds.y,
          linkURL: params.linkURL,
          srcURL: params.srcURL,
          mediaType: params.mediaType,
          selectionText: params.selectionText,
          isEditable: params.isEditable,
          editFlags: {
            canCut: params.editFlags.canCut,
            canCopy: params.editFlags.canCopy,
            canPaste: params.editFlags.canPaste,
            canSelectAll: params.editFlags.canSelectAll
          }
        })
      } catch {
        /* a broken menu must not take down the page */
      }
    })
    wc.on('audio-state-changed', (event) => {
      tab.audioPlaying = event.audible === true
      this.emit()
    })
    wc.on('did-navigate-in-page', changed)
    wc.on('page-title-updated', changed)
    wc.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
      // -3 = ERR_ABORTED (a new navigation started or the user stopped the
      // load): not a real failure, keep it out of the error toast.
      if (isMainFrame === false || code === -3) return
      this.onLoadError?.({ tabId: tab.id, url, code, desc })
    })
    wc.on('did-fail-load', changed)
    wc.on('render-process-gone', changed)

    wc.on('console-message', (...args: unknown[]) => {
      const details = args[0] as { level?: string; message?: string } | undefined
      const numLevel = typeof args[1] === 'number' ? (args[1] as number) : undefined
      const message = String(details?.message ?? args[2] ?? '')
      let level = details?.level
      if (!level && numLevel != null) {
        level = ['verbose', 'info', 'warning', 'error'][numLevel] ?? 'info'
      }
      tab.logs.push({ level: level ?? 'info', message: message.slice(0, 500), ts: Date.now() })
      if (tab.logs.length > 500) tab.logs.splice(0, tab.logs.length - 500)
    })

    wc.on('destroyed', () => {
      this.tabs.delete(tab.id)
      if (this.activeId === tab.id) {
        const rest = Array.from(this.tabs.keys())
        this.activeId = rest.length ? rest[rest.length - 1] : null
        if (this.activeId != null) this.activateView()
      }
      this.emit()
    })
  }

  private activateView(): void {
    const active = this.activeId != null ? this.tabs.get(this.activeId) : null
    for (const t of this.tabs.values()) {
      try {
        if (t.view.webContents.isDestroyed()) continue
        const isActive = t.id === this.activeId
        // Blank tabs stay hidden so the renderer start page shows through.
        t.view.setVisible(isActive && this.chromeOverlays.size === 0 && !this.isBlank(t))
      } catch {
        /* view already torn down */
      }
    }
    if (active) {
      try {
        if (!active.view.webContents.isDestroyed()) active.view.setBounds(this.bounds)
      } catch {
        /* ignore */
      }
    }
  }

  private isBlank(tab: Tab): boolean {
    try {
      const url = tab.view.webContents.getURL()
      return !url || url === 'about:blank'
    } catch {
      return true
    }
  }

  setActive(id: number): void {
    if (!this.tabs.has(id) || this.activeId === id) return
    this.activeId = id
    this.activateView()
    this.emit()
  }

  /** Replace the active shortcut map (effective bindings from settings). */
  setShortcuts(map: Record<ShortcutAction, string>): void {
    this.shortcutsMap = { ...DEFAULT_SHORTCUTS, ...map }
  }

  closeTab(id: number): boolean {
    const tab = this.tabs.get(id)
    if (!tab) return false
    const closedUrl = tab.view.webContents.getURL()
    if (/^https?:\/\//i.test(closedUrl)) {
      this.closedTabs.push({ url: closedUrl, title: tab.view.webContents.getTitle() || closedUrl })
      if (this.closedTabs.length > 10) this.closedTabs.shift()
    }
    // capture the tab order BEFORE the closed tab leaves the map so the new
    // active tab is its right neighbor (falling back to the left one)
    const ids = Array.from(this.tabs.keys())
    const index = ids.indexOf(id)
    this.tabs.delete(id)
    try {
      this.win.contentView.removeChildView(tab.view)
      tab.view.webContents.close()
    } catch {
      /* already gone */
    }
    if (this.activeId === id) {
      const right = index >= 0 ? ids[index + 1] : undefined
      const left = index > 0 ? ids[index - 1] : undefined
      let next: number | null = null
      if (right != null && this.tabs.has(right)) next = right
      else if (left != null && this.tabs.has(left)) next = left
      else {
        const rest = Array.from(this.tabs.keys())
        next = rest.length ? rest[rest.length - 1] : null
      }
      this.activeId = next
    }
    this.activateView()
    this.emit()
    return true
  }

  setChromeOverlay(id: string, open: boolean): void {
    if (!id || id.length > 64) return
    if (open) this.chromeOverlays.add(id)
    else this.chromeOverlays.delete(id)
    this.activateView()
  }

  /** Send a command to every tab's page overlay preload (e.g. hotkey config). */
  broadcastOverlay(cmd: unknown): void {
    for (const t of this.tabs.values()) {
      try {
        if (!t.view.webContents.isDestroyed()) t.view.webContents.send('overlay:cmd', cmd)
      } catch {
        /* view is going away */
      }
    }
  }

  /**
   * Reopen a closed tab. Without an index the most recently closed one is
   * reopened; an explicit index picks an entry from `getClosedTabs()`.
   */
  reopenClosed(index?: number): boolean {
    const idx = index == null ? this.closedTabs.length - 1 : index
    if (idx < 0 || idx >= this.closedTabs.length) return false
    const entry = this.closedTabs.splice(idx, 1)[0]
    if (!entry) return false
    this.createTab(entry.url)
    return true
  }

  /** Closed-tab memory, oldest first (the last item is the most recent). */
  getClosedTabs(): ClosedTabEntry[] {
    return this.closedTabs.map((entry) => ({ ...entry }))
  }

  /** True when there is at least one closed tab URL that can be reopened. */
  canReopenClosed(): boolean {
    return this.closedTabs.length > 0
  }

  /** Flip the tab's audio mute state (Chrome-style speaker control). */
  toggleMute(id: number): boolean {
    const tab = this.tabs.get(id)
    if (!tab) return false
    try {
      const wc = tab.view.webContents
      if (wc.isDestroyed()) return false
      wc.setAudioMuted(!wc.isAudioMuted())
      this.emit()
      return true
    } catch {
      return false
    }
  }

  /** Open a new tab with the same URL as the given tab (duplicate). */
  duplicateTab(id: number): boolean {
    const tab = this.tabs.get(id)
    if (!tab) return false
    try {
      this.createTab(tab.view.webContents.getURL())
      return true
    } catch {
      return false
    }
  }

  closeOthers(keepId: number): void {
    for (const id of Array.from(this.tabs.keys())) if (id !== keepId) this.closeTab(id)
    this.setActive(keepId)
  }

  closeToRight(id: number): void {
    const ids = Array.from(this.tabs.keys())
    const index = ids.indexOf(id)
    for (const next of ids.slice(index + 1)) this.closeTab(next)
  }

  getTab(id?: number | null): Tab | null {
    if (id == null) {
      return this.activeId != null ? (this.tabs.get(this.activeId) ?? null) : null
    }
    return this.tabs.get(id) ?? null
  }

  getActive(): Tab | null {
    return this.getTab(null)
  }

  requireTab(id?: number | null): Tab {
    const tab = this.getTab(id)
    if (!tab) {
      throw new Error(
        id == null
          ? 'No active tab. Open one with new_tab first.'
          : `No tab with id ${id}. Use list_tabs.`
      )
    }
    return tab
  }

  updateBounds(bounds: ContentBounds): void {
    this.bounds = bounds
    for (const tab of this.tabs.values()) {
      try {
        if (!tab.view.webContents.isDestroyed()) tab.view.setBounds(bounds)
      } catch {
        /* view is going away */
      }
    }
  }

  list(): TabInfo[] {
    const out: TabInfo[] = []
    for (const t of this.tabs.values()) {
      try {
        const wc = t.view.webContents
        if (wc.isDestroyed()) continue
        out.push({
          id: t.id,
          url: wc.getURL(),
          title: wc.getTitle(),
          loading: wc.isLoading(),
          active: t.id === this.activeId,
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          favicon: t.favicon,
          audioMuted: wc.isAudioMuted(),
          audioPlaying: t.audioPlaying === true
        })
      } catch {
        /* skip tabs that are going away */
      }
    }
    return out
  }

  destroy(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    for (const id of Array.from(this.tabs.keys())) this.closeTab(id)
  }

  private emit(): void {
    // Fires from async webContents events (including during teardown) —
    // a UI-refresh callback must never take down the main process.
    try {
      this.onChanged()
    } catch {
      /* ignore */
    }
  }
}
