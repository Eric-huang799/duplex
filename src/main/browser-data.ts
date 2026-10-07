import fs from 'node:fs'
import path from 'node:path'

export interface BookmarkRecord {
  url: string
  title: string
  favicon?: string
  addedAt: number
  folder?: string
}

export interface HistoryRecord {
  url: string
  title: string
  visitedAt: number
  favicon?: string
}

export interface DownloadRecord {
  id: string
  filename: string
  path: string
  url: string
  state: 'progressing' | 'completed' | 'interrupted' | 'cancelled'
  receivedBytes: number
  totalBytes: number
  startedAt: number
  endedAt?: number
}

interface BrowserData {
  bookmarks: BookmarkRecord[]
  bookmarkFolders: string[]
  history: HistoryRecord[]
  downloads: DownloadRecord[]
}

const empty = (): BrowserData => ({
  bookmarks: [],
  bookmarkFolders: [],
  history: [],
  downloads: []
})

const SAVE_DEBOUNCE_MS = 500

export class BrowserDataStore {
  private data: BrowserData
  private file: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  /** Bumped by every synchronous flush so stale async writes skip their rename. */
  private writeSeq = 0

  constructor(directory: string) {
    this.file = path.join(directory, 'browser-data.json')
    this.data = this.load()
  }

  /** Normalize a parsed payload into the in-memory shape. */
  private normalize(parsed: Partial<BrowserData>): BrowserData {
    const folders = Array.isArray(parsed.bookmarkFolders)
      ? [
          ...new Set(
            parsed.bookmarkFolders
              .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
              .map((name) => name.trim())
          )
        ]
      : []
    const data: BrowserData = {
      bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
      bookmarkFolders: folders,
      history: Array.isArray(parsed.history) ? parsed.history.slice(-5000) : [],
      downloads: Array.isArray(parsed.downloads) ? parsed.downloads.slice(-500) : []
    }
    for (const item of data.downloads) {
      if (item.state === 'progressing') item.state = 'interrupted'
    }
    return data
  }

  /**
   * Read the store from disk. A corrupt main file falls back to the .bak
   * (logged loudly). When both are unusable, the corrupt file is renamed to
   * `browser-data.json.corrupt-<stamp>` so it is kept for inspection and the
   * next write cannot silently reuse it.
   */
  private load(): BrowserData {
    const file = this.file
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      return empty()
    }
    try {
      return this.normalize(JSON.parse(raw) as Partial<BrowserData>)
    } catch {
      /* the main file is corrupt: try the backup */
    }
    try {
      const data = this.normalize(
        JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')) as Partial<BrowserData>
      )
      console.error('[browser-data] browser-data.json 解析失败，已回退读取 browser-data.json.bak')
      return data
    } catch {
      this.quarantineCorrupt(file)
      return empty()
    }
  }

  /** Rename an unusable browser-data.json aside (unique name per second). */
  private quarantineCorrupt(file: string): void {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const base = `${file}.corrupt-${stamp}`
    let target = base
    for (let n = 1; fs.existsSync(target); n++) target = `${base}-${n}`
    try {
      fs.renameSync(file, target)
      console.error(
        `[browser-data] browser-data.json 损坏且备份不可用，已留档为 ${path.basename(target)} 并重建空数据`
      )
    } catch (e) {
      console.error('[browser-data] 损坏文件留档失败：', (e as Error)?.message ?? e)
    }
  }

  snapshot(): BrowserData { return structuredClone(this.data) }

  /**
   * Coalesced async write: the first change schedules a write ~500ms later;
   * further changes within that window ride along, so navigation bursts
   * cannot pile up synchronous serializations.
   */
  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.writeAsync()
    }, SAVE_DEBOUNCE_MS)
  }

  private async writeAsync(): Promise<void> {
    const seq = ++this.writeSeq
    const file = this.file
    const tmp = `${file}.${process.pid}-${Date.now().toString(36)}.tmp`
    try {
      const json = JSON.stringify(this.data)
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.writeFile(tmp, json, 'utf8')
      if (seq !== this.writeSeq) {
        // a synchronous flush (e.g. clear) superseded this snapshot
        await fs.promises.unlink(tmp)
        return
      }
      // keep the previous on-disk version as .bak before replacing it; runs
      // after the supersede check so a raced clear() keeps its own .bak
      this.refreshBackup()
      await fs.promises.rename(tmp, file)
    } catch (e) {
      try {
        await fs.promises.unlink(tmp)
      } catch {
        /* tmp cleanup is best-effort */
      }
      console.error('[browser-data] 异步写盘失败：', (e as Error)?.message ?? e)
    }
  }

  /** Cancel any pending debounce and persist the current snapshot synchronously. */
  private flushNow(): void {
    this.writeSeq++ // invalidate any in-flight async write
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    // keep the previous on-disk version as .bak before replacing it (this is
    // what clearHistory/clearDownloads rely on)
    this.refreshBackup()
    const tmp = `${this.file}.${process.pid}-${Date.now().toString(36)}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (e) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* tmp cleanup is best-effort */
      }
      console.error('[browser-data] 写盘失败：', (e as Error)?.message ?? e)
    }
  }

  /** Copy the current file to browser-data.json.bak when it is non-empty and parseable. */
  private refreshBackup(): void {
    try {
      const stat = fs.statSync(this.file)
      if (!stat.isFile() || stat.size === 0) return
      JSON.parse(fs.readFileSync(this.file, 'utf8'))
      fs.copyFileSync(this.file, `${this.file}.bak`)
    } catch {
      /* missing or unparseable file: keep any existing backup untouched */
    }
  }

  addHistory(record: HistoryRecord): void {
    if (!/^https?:\/\//i.test(record.url)) return
    this.data.history.push(record)
    if (this.data.history.length > 5000) this.data.history.splice(0, this.data.history.length - 5000)
    this.scheduleSave()
  }

  updateLatestHistory(url: string, title: string, favicon?: string): void {
    const item = [...this.data.history].reverse().find((entry) => entry.url === url)
    if (!item) return
    if (title) item.title = title
    if (favicon) item.favicon = favicon
    this.scheduleSave()
  }

  removeHistory(url: string, visitedAt: number): void {
    this.data.history = this.data.history.filter((item) => item.url !== url || item.visitedAt !== visitedAt)
    this.scheduleSave()
  }

  clearHistory(): void {
    this.data.history = []
    this.flushNow()
  }

  toggleBookmark(record: Omit<BookmarkRecord, 'addedAt'>): boolean {
    const exists = this.data.bookmarks.some((item) => item.url === record.url)
    this.data.bookmarks = exists
      ? this.data.bookmarks.filter((item) => item.url !== record.url)
      : [{ ...record, addedAt: Date.now() }, ...this.data.bookmarks]
    this.scheduleSave()
    return !exists
  }

  /**
   * Add a bookmark, or update the existing one for the same URL (upsert).
   * Only a non-empty `folder` string is retained; anything else leaves the
   * bookmark at the root. The folder list is managed separately via addFolder.
   */
  addBookmark(record: {
    url: string
    title: string
    favicon?: string
    folder?: string
  }): { ok: boolean; error?: string } {
    const url = record.url?.trim() ?? ''
    if (!url) return { ok: false, error: '网址不能为空' }
    const title = record.title?.trim() || url
    const favicon = record.favicon?.trim() || undefined
    const folder = record.folder?.trim() || undefined
    const index = this.data.bookmarks.findIndex((item) => item.url === url)
    if (index >= 0) {
      const item = this.data.bookmarks[index]
      item.title = title
      if (favicon) item.favicon = favicon
      if (folder) item.folder = folder
      else delete item.folder
    } else {
      const item: BookmarkRecord = { url, title, addedAt: Date.now() }
      if (favicon) item.favicon = favicon
      if (folder) item.folder = folder
      this.data.bookmarks.unshift(item)
    }
    this.scheduleSave()
    return { ok: true }
  }

  /**
   * Patch a bookmark addressed by its current URL. Changing the URL onto an
   * already-bookmarked one is rejected. An empty/omitted `folder` moves the
   * bookmark back to the root (未分类).
   */
  updateBookmark(
    url: string,
    patch: { title?: string; url?: string; folder?: string }
  ): { ok: boolean; error?: string } {
    const index = this.data.bookmarks.findIndex((item) => item.url === url)
    if (index < 0) return { ok: false, error: '书签不存在' }
    const item = this.data.bookmarks[index]
    if (patch.url !== undefined) {
      const nextUrl = patch.url.trim()
      if (!nextUrl) return { ok: false, error: '网址不能为空' }
      if (nextUrl !== item.url) {
        if (this.data.bookmarks.some((entry) => entry.url === nextUrl)) {
          return { ok: false, error: '该网址已有书签' }
        }
        item.url = nextUrl
      }
    }
    if (patch.title !== undefined) item.title = patch.title.trim() || item.url
    if (patch.folder !== undefined) {
      const folder = patch.folder.trim()
      if (folder) item.folder = folder
      else delete item.folder
    }
    this.scheduleSave()
    return { ok: true }
  }

  /** Remove a bookmark by URL; returns false when there was nothing to remove. */
  removeBookmark(url: string): boolean {
    const before = this.data.bookmarks.length
    this.data.bookmarks = this.data.bookmarks.filter((item) => item.url !== url)
    const removed = this.data.bookmarks.length !== before
    if (removed) this.scheduleSave()
    return removed
  }

  /** Create a bookmark folder (trimmed, deduped). */
  addFolder(name: string): { ok: boolean; error?: string } {
    const value = name?.trim() ?? ''
    if (!value) return { ok: false, error: '文件夹名称不能为空' }
    if (this.data.bookmarkFolders.includes(value)) {
      return { ok: false, error: '文件夹已存在' }
    }
    this.data.bookmarkFolders.push(value)
    this.scheduleSave()
    return { ok: true }
  }

  /** Delete a folder; bookmarks inside it return to the root (未分类). */
  removeFolder(name: string): boolean {
    const value = typeof name === 'string' ? name.trim() : ''
    const index = this.data.bookmarkFolders.indexOf(value)
    if (index < 0) return false
    this.data.bookmarkFolders.splice(index, 1)
    for (const item of this.data.bookmarks) {
      if (item.folder === value) delete item.folder
    }
    this.scheduleSave()
    return true
  }

  /** Rename a folder and move its bookmarks along with it. */
  renameFolder(oldName: string, newName: string): { ok: boolean; error?: string } {
    const oldValue = typeof oldName === 'string' ? oldName.trim() : ''
    const newValue = newName?.trim() ?? ''
    const index = this.data.bookmarkFolders.indexOf(oldValue)
    if (index < 0) return { ok: false, error: '文件夹不存在' }
    if (!newValue) return { ok: false, error: '文件夹名称不能为空' }
    if (newValue === oldValue) return { ok: true }
    if (this.data.bookmarkFolders.includes(newValue)) {
      return { ok: false, error: '文件夹已存在' }
    }
    this.data.bookmarkFolders[index] = newValue
    for (const item of this.data.bookmarks) {
      if (item.folder === oldValue) item.folder = newValue
    }
    this.scheduleSave()
    return { ok: true }
  }

  addDownload(record: DownloadRecord): void {
    const index = this.data.downloads.findIndex((item) => item.id === record.id)
    if (index >= 0) this.data.downloads[index] = record
    else this.data.downloads.push(record)
    if (this.data.downloads.length > 500) this.data.downloads.splice(0, this.data.downloads.length - 500)
    this.scheduleSave()
  }

  clearDownloads(): void {
    this.data.downloads = []
    this.flushNow()
  }
}
