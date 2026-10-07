import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BrowserDataStore } from '../src/main/browser-data'

// 书签变更是 500ms 防抖落盘的；除持久化用例外统一用假定时器，避免测试结束
// 删除临时目录后仍有延迟写入落进来（真定时器的持久化用例自行切回真实时钟）。
describe('BrowserDataStore bookmarks', () => {
  let dir = ''
  let store: BrowserDataStore
  beforeEach(() => {
    vi.useFakeTimers()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-bookmarks-'))
    store = new BrowserDataStore(dir)
  })
  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const dataFile = (): string => path.join(dir, 'browser-data.json')

  it('adds new bookmarks at the front and upserts an existing url', () => {
    expect(store.addBookmark({ url: 'https://a.example/', title: 'A' })).toEqual({ ok: true })
    expect(store.addBookmark({ url: 'https://b.example/', title: 'B' })).toEqual({ ok: true })
    const first = store.snapshot().bookmarks
    expect(first.map((b) => b.url)).toEqual(['https://b.example/', 'https://a.example/'])
    expect(first[1].addedAt).toBeGreaterThan(0)

    const addedAt = first[1].addedAt
    expect(
      store.addBookmark({
        url: 'https://a.example/',
        title: 'A2',
        favicon: 'https://a.example/favicon.ico'
      })
    ).toEqual({ ok: true })
    const list = store.snapshot().bookmarks
    expect(list.length).toBe(2)
    const a = list.find((b) => b.url === 'https://a.example/')!
    expect(a.title).toBe('A2')
    expect(a.favicon).toBe('https://a.example/favicon.ico')
    expect(a.addedAt).toBe(addedAt)
    // 未提供 favicon 的 upsert 保留原有图标
    store.addBookmark({ url: 'https://a.example/', title: 'A3' })
    expect(store.snapshot().bookmarks.find((b) => b.url === 'https://a.example/')!.favicon).toBe(
      'https://a.example/favicon.ico'
    )
  })

  it('rejects an empty url and falls back to the url as title', () => {
    expect(store.addBookmark({ url: '   ', title: 'x' })).toEqual({
      ok: false,
      error: '网址不能为空'
    })
    store.addBookmark({ url: 'https://c.example/', title: '   ', folder: '  ' })
    const c = store.snapshot().bookmarks[0]
    expect(c.title).toBe('https://c.example/')
    expect(c.folder).toBeUndefined()
  })

  it('retains a non-empty folder only, and clearing it moves the bookmark back to the root', () => {
    store.addBookmark({ url: 'https://a.example/', title: 'A', folder: '工作' })
    expect(store.snapshot().bookmarks[0].folder).toBe('工作')
    // upsert 不带 folder：只有非空字符串才会被保留
    store.addBookmark({ url: 'https://a.example/', title: 'A' })
    expect(store.snapshot().bookmarks[0].folder).toBeUndefined()

    store.updateBookmark('https://a.example/', { folder: '阅读' })
    expect(store.snapshot().bookmarks[0].folder).toBe('阅读')
    store.updateBookmark('https://a.example/', { folder: '' })
    expect(store.snapshot().bookmarks[0].folder).toBeUndefined()
  })

  it('updates url/title and rejects url conflicts without touching the record', () => {
    store.addBookmark({ url: 'https://a.example/', title: 'A' })
    store.addBookmark({ url: 'https://b.example/', title: 'B' })
    expect(store.updateBookmark('https://missing.example/', { title: 'x' })).toEqual({
      ok: false,
      error: '书签不存在'
    })
    expect(store.updateBookmark('https://b.example/', { url: 'https://a.example/' })).toEqual({
      ok: false,
      error: '该网址已有书签'
    })
    expect(store.updateBookmark('https://b.example/', { url: '   ' })).toEqual({
      ok: false,
      error: '网址不能为空'
    })
    const b = store.snapshot().bookmarks.find((x) => x.title === 'B')!
    expect(b.url).toBe('https://b.example/')

    expect(
      store.updateBookmark('https://b.example/', {
        url: 'https://b2.example/',
        title: 'B2',
        folder: '阅读'
      })
    ).toEqual({ ok: true })
    const moved = store.snapshot().bookmarks.find((x) => x.title === 'B2')!
    expect(moved.url).toBe('https://b2.example/')
    expect(moved.folder).toBe('阅读')
  })

  it('removes bookmarks regardless of folder and tolerates missing urls', () => {
    store.addBookmark({ url: 'https://a.example/', title: 'A', folder: '工作' })
    expect(store.removeBookmark('https://a.example/')).toBe(true)
    expect(store.snapshot().bookmarks).toEqual([])
    expect(store.removeBookmark('https://a.example/')).toBe(false)
  })

  it('still toggles a bookmarked url that lives in a folder (star button regression)', () => {
    store.addBookmark({ url: 'https://a.example/', title: 'A', folder: '工作' })
    expect(store.toggleBookmark({ url: 'https://a.example/', title: 'A' })).toBe(false)
    expect(store.snapshot().bookmarks).toEqual([])
    expect(store.toggleBookmark({ url: 'https://a.example/', title: 'A' })).toBe(true)
    expect(store.snapshot().bookmarks[0].folder).toBeUndefined()
  })

  it('manages folders: add trims/dedupes, rename cascades, remove returns bookmarks to the root', () => {
    expect(store.addFolder('  工作  ')).toEqual({ ok: true })
    expect(store.snapshot().bookmarkFolders).toEqual(['工作'])
    expect(store.addFolder('   ')).toEqual({ ok: false, error: '文件夹名称不能为空' })
    expect(store.addFolder('工作')).toEqual({ ok: false, error: '文件夹已存在' })

    store.addFolder('阅读')
    store.addBookmark({ url: 'https://a.example/', title: 'A', folder: '工作' })
    store.addBookmark({ url: 'https://b.example/', title: 'B', folder: '阅读' })

    expect(store.renameFolder('工作', '阅读')).toEqual({ ok: false, error: '文件夹已存在' })
    expect(store.renameFolder('不存在', 'x')).toEqual({ ok: false, error: '文件夹不存在' })
    expect(store.renameFolder('工作', '  ')).toEqual({ ok: false, error: '文件夹名称不能为空' })
    expect(store.renameFolder('工作', '工作')).toEqual({ ok: true })

    expect(store.renameFolder('工作', '项目')).toEqual({ ok: true })
    expect(store.snapshot().bookmarkFolders).toEqual(['项目', '阅读'])
    expect(store.snapshot().bookmarks.find((b) => b.url === 'https://a.example/')!.folder).toBe('项目')

    expect(store.removeFolder('项目')).toBe(true)
    expect(store.snapshot().bookmarkFolders).toEqual(['阅读'])
    expect(store.snapshot().bookmarks.find((b) => b.url === 'https://a.example/')!.folder).toBeUndefined()
    expect(store.removeFolder('项目')).toBe(false)
  })

  it('persists bookmarkFolders, reloads them, and tolerates a legacy file without the field', async () => {
    vi.useRealTimers()
    store.addFolder('工作')
    store.addBookmark({
      url: 'https://a.example/',
      title: 'A',
      favicon: 'https://a.example/favicon.ico',
      folder: '工作'
    })
    await new Promise((resolve) => setTimeout(resolve, 700))
    const raw = JSON.parse(fs.readFileSync(dataFile(), 'utf8')) as {
      bookmarkFolders: string[]
      bookmarks: Array<{ url: string; folder?: string }>
    }
    expect(raw.bookmarkFolders).toEqual(['工作'])
    expect(raw.bookmarks[0].folder).toBe('工作')

    const reloaded = new BrowserDataStore(dir)
    expect(reloaded.snapshot().bookmarkFolders).toEqual(['工作'])
    expect(reloaded.snapshot().bookmarks).toHaveLength(1)
    expect(reloaded.snapshot().bookmarks[0].folder).toBe('工作')

    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-bookmarks-legacy-'))
    try {
      fs.writeFileSync(
        path.join(legacyDir, 'browser-data.json'),
        JSON.stringify({
          bookmarks: [{ url: 'https://x.example/', title: 'X', addedAt: 1 }],
          history: [],
          downloads: []
        }),
        'utf8'
      )
      const legacy = new BrowserDataStore(legacyDir)
      expect(legacy.snapshot().bookmarkFolders).toEqual([])
      // 旧数据缺少 folder 字段时书签仍可用
      expect(legacy.snapshot().bookmarks[0].folder).toBeUndefined()
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true })
    }
  })
})
