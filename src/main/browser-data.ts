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

export class BrowserDataStore {
  private data: BrowserData
  private file: string

  constructor(directory: string) {
    this.file = path.join(directory, 'browser-data.json')
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<BrowserData>
      this.data = {
        bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
        history: Array.isArray(parsed.history) ? parsed.history.slice(-5000) : [],
        downloads: Array.isArray(parsed.downloads) ? parsed.downloads.slice(-500) : []
      }
      for (const item of this.data.downloads) {
        if (item.state === 'progressing') item.state = 'interrupted'
      }
    } catch {
      this.data = empty()
    }
  }

  snapshot(): BrowserData { return structuredClone(this.data) }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8')
    fs.renameSync(tmp, this.file)
  }

  addHistory(record: HistoryRecord): void {
    if (!/^https?:\/\//i.test(record.url)) return
    this.data.history.push(record)
    if (this.data.history.length > 5000) this.data.history.splice(0, this.data.history.length - 5000)
    this.save()
  }

  updateLatestHistory(url: string, title: string, favicon?: string): void {
    const item = [...this.data.history].reverse().find((entry) => entry.url === url)
    if (!item) return
    if (title) item.title = title
    if (favicon) item.favicon = favicon
    this.save()
  }

  removeHistory(url: string, visitedAt: number): void {
    this.data.history = this.data.history.filter((item) => item.url !== url || item.visitedAt !== visitedAt)
    this.save()
  }

  clearHistory(): void { this.data.history = []; this.save() }

  toggleBookmark(record: Omit<BookmarkRecord, 'addedAt'>): boolean {
    const exists = this.data.bookmarks.some((item) => item.url === record.url)
    this.data.bookmarks = exists
      ? this.data.bookmarks.filter((item) => item.url !== record.url)
      : [{ ...record, addedAt: Date.now() }, ...this.data.bookmarks]
    this.save()
    return !exists
  }

  addDownload(record: DownloadRecord): void {
    const index = this.data.downloads.findIndex((item) => item.id === record.id)
    if (index >= 0) this.data.downloads[index] = record
    else this.data.downloads.push(record)
    if (this.data.downloads.length > 500) this.data.downloads.splice(0, this.data.downloads.length - 500)
    this.save()
  }

  clearDownloads(): void { this.data.downloads = []; this.save() }
}
