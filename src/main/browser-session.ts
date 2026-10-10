import fs from 'node:fs'
import path from 'node:path'
import type { TabInfo } from '../shared/protocol'

export interface BrowserSession {
  tabs: Array<{ url: string }>
  activeIndex: number
}

/** Browser navigation state, kept separate from AI conversation settings. */
export class BrowserSessionStore {
  private file: string
  private current: BrowserSession | null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(directory: string) {
    this.file = path.join(directory, 'browser-session.json')
    this.current = this.load()
  }

  private load(): BrowserSession | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as BrowserSession
      if (!Array.isArray(parsed.tabs)) return null
      const tabs = parsed.tabs.map((tab) => ({
        url: typeof tab?.url === 'string' && (/^https?:\/\//i.test(tab.url) || tab.url === 'about:blank')
          ? tab.url : 'about:blank'
      }))
      const activeIndex = Number.isInteger(parsed.activeIndex)
        ? Math.max(0, Math.min(parsed.activeIndex, tabs.length - 1)) : 0
      return { tabs, activeIndex }
    } catch {
      return null
    }
  }

  read(): BrowserSession | null {
    return this.current ? structuredClone(this.current) : null
  }

  update(tabs: TabInfo[], activeId: number | null): void {
    this.current = {
      tabs: tabs.map((tab) => ({ url: /^https?:\/\//i.test(tab.url) ? tab.url : 'about:blank' })),
      activeIndex: Math.max(0, tabs.findIndex((tab) => tab.id === activeId))
    }
    if (!this.timer) this.timer = setTimeout(() => this.flushNow(), 500)
  }

  flushNow(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.current) return
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(this.current), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (error) {
      try { fs.unlinkSync(tmp) } catch { /* nothing was written */ }
      console.error('[browser-session] 保存失败：', (error as Error).message)
    }
  }
}
