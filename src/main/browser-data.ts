import fs from 'node:fs'
import path from 'node:path'

export interface BookmarkRecord {
  url: string
  title: string
  favicon?: string
  addedAt: number
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
  history: HistoryRecord[]
  downloads: DownloadRecord[]
}

const empty = (): BrowserData => ({ bookmarks: [], history: [], downloads: [] })

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
    const data: BrowserData = {
      bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
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
