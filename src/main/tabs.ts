import { BrowserWindow, WebContentsView } from 'electron'
import type { ContentBounds, TabInfo } from '../shared/protocol'

export interface ConsoleEntry {
  level: string
  message: string
  ts: number
}

export interface Tab {
  id: number
  view: WebContentsView
  logs: ConsoleEntry[]
  favicon?: string
}

export class TabManager {
  private tabs = new Map<number, Tab>()
  private nextId = 1
  activeId: number | null = null
  private closedUrls: string[] = []
  private chromeOverlays = new Set<string>()
  private bounds: ContentBounds = { x: 0, y: 88, width: 1200, height: 760 }

  constructor(
    private win: BrowserWindow,
    private overlayPreload: string | null,
    private onChanged: () => void,
    private onNavigate: (url: string, title: string, favicon?: string) => void,
    private onShortcut: (action: string) => void,
    private onMetadata: (url: string, title: string, favicon?: string) => void
  ) {
    // Chromium can leave a WebContentsView "hidden" (suspended rendering,
    // rAF stopped) after the window was minimized/occluded. Nudge the active
    // view back alive on window-state events, plus a periodic watchdog.
    this.win.on('show', () => this.activateView())
    this.win.on('restore', () => this.activateView())
    this.win.on('focus', () => this.activateView())
    setInterval(() => void this.reviveActiveView(), 30_000)
  }

  /** If the active view lost its visibility (Electron quirk after occlusion),
   *  re-kick it so Chromium resumes painting and rAF. */
  private async reviveActiveView(): Promise<void> {
    try {
      if (!this.win.isVisible() || this.win.isMinimized()) return
      if (this.chromeOverlays.size > 0) return
      const active = this.activeId != null ? this.tabs.get(this.activeId) : null
      if (!active || this.isBlank(active)) return
      const state = await active.view.webContents.executeJavaScript(
        'document.visibilityState',
        true
      )
      if (state === 'hidden') {
        active.view.setVisible(false)
        setTimeout(() => {
          if (this.chromeOverlays.size > 0) return
          active.view.setVisible(true)
          active.view.setBounds(this.bounds)
        }, 80)
      }
    } catch {
      /* ignore */
    }
  }

  createTab(url?: string): Tab {
    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:cobrowse',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        ...(this.overlayPreload ? { preload: this.overlayPreload } : {})
      }
    })
    const tab: Tab = { id: this.nextId++, view, logs: [] }
    this.tabs.set(tab.id, tab)
    this.win.contentView.addChildView(view)
    view.setVisible(false)
    this.wireEvents(tab)

    view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      if (openUrl && /^https?:/i.test(openUrl)) this.createTab(openUrl)
      return { action: 'deny' }
    })

    this.setActive(tab.id)
    void view.webContents.loadURL(url ?? 'about:blank')
    this.emit()
    return tab
  }

  private wireEvents(tab: Tab): void {
    const wc = tab.view.webContents
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return
      const key = input.key.toLowerCase()
      const actions: Record<string, string> = {
        l: 'focusAddress', t: input.shift ? 'reopenClosed' : 'newTab',
        w: 'closeTab', r: 'reload', d: 'bookmark', f: 'find'
      }
      const action = input.key === 'Tab' ? (input.shift ? 'previousTab' : 'nextTab') : actions[key]
      if (!action) return
      event.preventDefault()
      if (action === 'closeTab') this.closeTab(tab.id)
      else if (action === 'reload') wc.reload()
      else this.onShortcut(action)
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
    wc.on('did-navigate-in-page', changed)
    wc.on('page-title-updated', changed)
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

  closeTab(id: number): boolean {
    const tab = this.tabs.get(id)
    if (!tab) return false
    const closedUrl = tab.view.webContents.getURL()
    if (/^https?:\/\//i.test(closedUrl)) {
      this.closedUrls.push(closedUrl)
      if (this.closedUrls.length > 10) this.closedUrls.shift()
    }
    this.tabs.delete(id)
    try {
      this.win.contentView.removeChildView(tab.view)
      tab.view.webContents.close()
    } catch {
      /* already gone */
    }
    if (this.activeId === id) {
      const rest = Array.from(this.tabs.keys())
      this.activeId = rest.length ? rest[rest.length - 1] : null
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

  reopenClosed(): boolean {
    const url = this.closedUrls.pop()
    if (!url) return false
    this.createTab(url)
    return true
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
    const active = this.getActive()
    if (!active) return
    try {
      if (!active.view.webContents.isDestroyed()) active.view.setBounds(bounds)
    } catch {
      /* ignore */
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
          favicon: t.favicon
        })
      } catch {
        /* skip tabs that are going away */
      }
    }
    return out
  }

  destroy(): void {
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
