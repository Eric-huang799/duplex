import { app, shell, type DownloadItem, type Session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { BrowserDataStore, DownloadRecord } from './browser-data'

export class DownloadManager {
  private active = new Map<string, DownloadItem>()
  private rows: DownloadRecord[]

  constructor(
    private session: Session,
    private store: BrowserDataStore,
    private emit: (rows: DownloadRecord[]) => void
  ) {
    this.rows = store.snapshot().downloads
    this.session.on('will-download', (_event, item) => this.begin(item))
  }

  private begin(item: DownloadItem): void {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const filename = item.getFilename()
    const directory = app.getPath('downloads')
    const ext = path.extname(filename)
    const stem = path.basename(filename, ext)
    let target = path.join(directory, filename)
    for (let suffix = 1; fs.existsSync(target); suffix++) target = path.join(directory, `${stem} (${suffix})${ext}`)
    item.setSavePath(target)
    this.active.set(id, item)
    const row: DownloadRecord = {
      id, filename, path: target, url: item.getURL(), state: 'progressing',
      receivedBytes: 0, totalBytes: item.getTotalBytes(), startedAt: Date.now()
    }
    let persistTimer: ReturnType<typeof setTimeout> | null = null
    this.upsert(row)
    item.on('updated', (_event, state) => {
      row.receivedBytes = item.getReceivedBytes()
      row.totalBytes = item.getTotalBytes()
      if (state === 'interrupted') row.state = 'interrupted'
      this.upsert(row, false)
      if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; this.persist(row) }, 500)
    })
    item.once('done', (_event, state) => {
      this.active.delete(id)
      if (persistTimer) clearTimeout(persistTimer)
      row.receivedBytes = item.getReceivedBytes()
      row.totalBytes = item.getTotalBytes()
      row.endedAt = Date.now()
      row.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      this.upsert(row)
    })
  }

  private upsert(row: DownloadRecord, persist = true): void {
    const index = this.rows.findIndex((item) => item.id === row.id)
    if (index < 0) this.rows.push({ ...row })
    else this.rows[index] = { ...row }
    if (persist) this.store.addDownload(row)
    this.emit(this.list())
  }

  private persist(row: DownloadRecord): void { this.store.addDownload(row) }

  list(): DownloadRecord[] { return this.rows.map((row) => ({ ...row })) }
  cancel(id: string): boolean { const item = this.active.get(id); if (!item) return false; item.cancel(); return true }
  clear(): void { this.rows = []; this.store.clearDownloads(); this.emit([]) }
  async open(id: string): Promise<void> {
    const row = this.rows.find((item) => item.id === id && item.state === 'completed')
    if (row) await shell.openPath(row.path)
  }
  reveal(id: string): void {
    const row = this.rows.find((item) => item.id === id)
    if (row) shell.showItemInFolder(row.path)
  }
}
