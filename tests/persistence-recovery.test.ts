import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserDataStore } from '../src/main/browser-data'
import { BrowserSessionStore } from '../src/main/browser-session'
import type { TabInfo } from '../src/shared/protocol'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-persist-'))
}

function validData(): string {
  return JSON.stringify({
    history: [{ url: 'https://example.com/', title: 'Example', visitedAt: 1700000000000 }],
    bookmarks: [],
    downloads: [],
    bookmarkFolders: []
  })
}

function tab(id: number, url: string, incognito?: boolean): TabInfo {
  return {
    id,
    url,
    title: url,
    loading: false,
    active: false,
    canGoBack: false,
    canGoForward: false,
    ...(incognito ? { incognito: true } : {})
  }
}

describe('BrowserDataStore 读取失败的数据安全', () => {
  let dir = ''

  beforeEach(() => {
    dir = tmpDir()
  })

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('主文件缺失但 .bak 可用时，从备份恢复而不是当成空库', () => {
    fs.writeFileSync(path.join(dir, 'browser-data.json.bak'), validData(), 'utf8')
    const store = new BrowserDataStore(dir)
    expect(store.isDegraded()).toBe(false)
    expect(store.snapshot().history).toHaveLength(1)
    expect(store.snapshot().history[0]?.url).toBe('https://example.com/')
  })

  it('主文件与备份都不存在时是全新安装，不降级', () => {
    const store = new BrowserDataStore(dir)
    expect(store.isDegraded()).toBe(false)
    expect(store.snapshot().history).toHaveLength(0)
  })

  it('主文件不可读且无备份时进入只读降级，并且拒绝写盘（不覆盖现有文件）', () => {
    // 用"同名目录"制造一个跨平台的读失败（Node 会抛 EISDIR）
    const dataPath = path.join(dir, 'browser-data.json')
    fs.mkdirSync(dataPath)

    const store = new BrowserDataStore(dir)
    expect(store.isDegraded()).toBe(true)

    store.addHistory({ url: 'https://evil.example/', title: 'x', visitedAt: Date.now() })
    store.flushNow()

    // 关键断言：原来那个"文件"仍然在，没有被空库快照 rename 覆盖
    expect(fs.statSync(dataPath).isDirectory()).toBe(true)
  })

  it('正常读取后写盘仍然工作', () => {
    fs.writeFileSync(path.join(dir, 'browser-data.json'), validData(), 'utf8')
    const store = new BrowserDataStore(dir)
    expect(store.isDegraded()).toBe(false)
    store.addHistory({ url: 'https://second.example/', title: 'Second', visitedAt: Date.now() })
    store.flushNow()

    const reread = new BrowserDataStore(dir)
    expect(reread.snapshot().history).toHaveLength(2)
  })
})

describe('BrowserSessionStore 不持久化隐身标签', () => {
  let dir = ''
  beforeEach(() => {
    dir = tmpDir()
  })
  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('隐身标签的 URL 不写进 browser-session.json', () => {
    const store = new BrowserSessionStore(dir)
    store.update(
      [tab(1, 'https://normal.example/'), tab(2, 'https://secret.example/private', true)],
      1
    )
    store.flushNow()

    const raw = fs.readFileSync(path.join(dir, 'browser-session.json'), 'utf8')
    expect(raw).not.toContain('secret.example')
    const parsed = JSON.parse(raw) as { tabs: Array<{ url: string }>; activeIndex: number }
    expect(parsed.tabs).toEqual([{ url: 'https://normal.example/' }])
    expect(parsed.activeIndex).toBe(0)
  })

  it('只有隐身标签时不落任何 URL，活动索引回落为 0', () => {
    const store = new BrowserSessionStore(dir)
    store.update([tab(9, 'https://secret.example/', true)], 9)
    store.flushNow()
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, 'browser-session.json'), 'utf8')
    ) as { tabs: unknown[]; activeIndex: number }
    expect(parsed.tabs).toEqual([])
    expect(parsed.activeIndex).toBe(0)
  })
})
