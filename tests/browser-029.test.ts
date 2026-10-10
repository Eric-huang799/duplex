import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  WebContentsView: class {
    visible = false
    bounds: unknown = null
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: () => {}, loadURL: async () => {}, isDestroyed: () => false,
      getURL: () => 'https://example.com', getTitle: () => 'Example', isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      isAudioMuted: () => false, close: () => {}, executeJavaScript: async () => 'visible'
    })
    setVisible(value: boolean) { this.visible = value }
    setBounds(value: unknown) { this.bounds = value }
  }
}))

import { TabManager } from '../src/main/tabs'
import { BrowserDataStore } from '../src/main/browser-data'

const managers: TabManager[] = []
const directories: string[] = []
afterEach(() => {
  managers.forEach((manager) => manager.destroy())
  directories.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }))
  managers.length = 0
  directories.length = 0
})

describe('browser collaboration 0.2.9', () => {
  it('restores tab order and the human selection from a flushed browser session', async () => {
    const { BrowserSessionStore } = await import('../src/main/browser-session')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-session-029-'))
    directories.push(dir)
    const store = new BrowserSessionStore(dir)
    store.update([
      { id: 10, url: 'https://human.example' },
      { id: 20, url: 'https://research.example' },
      { id: 30, url: 'about:blank' }
    ] as never, 20)
    store.flushNow()
    expect(new BrowserSessionStore(dir).read()).toEqual({
      tabs: [{ url: 'https://human.example' }, { url: 'https://research.example' }, { url: 'about:blank' }],
      activeIndex: 1
    })
  })

  it('keeps the human tab visible while a background tab receives current page bounds', () => {
    const win = Object.assign(new EventEmitter(), { contentView: { addChildView() {}, removeChildView() {} } })
    const manager = new TabManager(win as never, null, () => {}, () => {}, () => {}, () => {})
    managers.push(manager)
    const human = manager.createTab('https://human.example')
    const bounds = { x: 0, y: 90, width: 900, height: 700 }
    manager.updateBounds(bounds)
    const ai = manager.createTab('https://ai.example', { background: true })
    expect(manager.activeId).toBe(human.id)
    expect((ai.view as unknown as { visible: boolean }).visible).toBe(false)
    expect((ai.view as unknown as { bounds: unknown }).bounds).toEqual(bounds)
  })

  it('attaches the originating tab to load errors and find results', () => {
    const loadErrors: unknown[] = [], findResults: unknown[] = []
    const win = Object.assign(new EventEmitter(), { contentView: { addChildView() {}, removeChildView() {} } })
    const manager = new TabManager(win as never, null, () => {}, () => {}, () => {}, () => {},
      (error) => loadErrors.push(error), (result) => findResults.push(result))
    managers.push(manager)
    const tab = manager.createTab('https://failed.example')
    tab.view.webContents.emit('did-fail-load', {}, -105, 'DNS failed', 'https://failed.example', true)
    tab.view.webContents.emit('found-in-page', {}, { matches: 3, activeMatchOrdinal: 2 })
    expect(loadErrors).toEqual([{ tabId: tab.id, url: 'https://failed.example', code: -105, desc: 'DNS failed' }])
    expect(findResults).toEqual([{ tabId: tab.id, matches: 3, activeMatch: 2 }])
  })

  it('persists a last-second bookmark before the debounce runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-browser-029-'))
    directories.push(dir)
    const store = new BrowserDataStore(dir)
    store.addBookmark({ url: 'https://research.example', title: 'Research' })
    expect(typeof store.flushNow).toBe('function')
    store.flushNow()
    expect(new BrowserDataStore(dir).snapshot().bookmarks[0]?.url).toBe('https://research.example')
  })
})
