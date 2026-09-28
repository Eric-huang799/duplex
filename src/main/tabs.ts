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
}

export class TabManager {
  private tabs = new Map<number, Tab>()
  private nextId = 1
  activeId: number | null = null
  private bounds: ContentBounds = { x: 0, y: 88, width: 1200, height: 760 }

  constructor(
    private win: BrowserWindow,
    private overlayPreload: string | null,
    private onChanged: () => void
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
      const active = this.activeId != null ? this.tabs.get(this.activeId) : null
      if (!active || this.isBlank(active)) return
      const state = await active.view.webContents.executeJavaScript(
        'document.visibilityState',
        true
      )
      if (state === 'hidden') {
        active.view.setVisible(false)
        setTimeout(() => {
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
    const changed = (): void => {
      if (tab.id === this.activeId) this.activateView()
      this.emit()
    }
    wc.on('did-start-loading', changed)
    wc.on('did-stop-loading', changed)
    wc.on('did-navigate', changed)
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
      const isActive = t.id === this.activeId
      // Blank tabs stay hidden so the renderer start page shows through.
      t.view.setVisible(isActive && !this.isBlank(t))
    }
    if (active) {
      active.view.setBounds(this.bounds)
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
    if (active) active.view.setBounds(bounds)
  }

  list(): TabInfo[] {
    return Array.from(this.tabs.values()).map((t) => {
      const wc = t.view.webContents
      return {
        id: t.id,
        url: wc.getURL(),
        title: wc.getTitle(),
        loading: wc.isLoading(),
        active: t.id === this.activeId,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward()
      }
    })
  }

  destroy(): void {
    for (const id of Array.from(this.tabs.keys())) this.closeTab(id)
  }

  private emit(): void {
    this.onChanged()
  }
}
