import { app, shell, type DownloadItem, type Session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { BrowserDataStore, DownloadRecord } from './browser-data'

/** Structured result shared by downloadsOpen / downloadsReveal (surfaced over IPC). */
export interface DownloadActionResult {
  ok: boolean
  error?: string
}

export class DownloadManager {
  private active = new Map<string, DownloadItem>()
  private rows: DownloadRecord[]

  constructor(
    private session: Session,
    private store: BrowserDataStore,
    private emit: (rows: DownloadRecord[]) => void,
    /**
     * When true, leave the save path to Electron so the native Save dialog
     * appears; when false, auto-save into the downloads directory (unique name).
     * Defaults to asking, matching the settings default.
     */
    private getConfirmBeforeDownload: () => boolean = () => true
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

    let confirm = true
    try {
      confirm = this.getConfirmBeforeDownload()
    } catch {
      confirm = true
    }
    if (!confirm) {
      item.setSavePath(target)
    } else {
      // No setSavePath here: Electron prompts the user and records the chosen
      // path on the item, which we pick up from getSavePath() below.
      target = ''
    }

    this.active.set(id, item)
    const row: DownloadRecord = {
      id, filename, path: target, url: item.getURL(), state: 'progressing',
      receivedBytes: 0, totalBytes: item.getTotalBytes(), startedAt: Date.now()
    }
    let persistTimer: ReturnType<typeof setTimeout> | null = null
    this.upsert(row)
    item.on('updated', (_event, state) => {
      const chosen = item.getSavePath()
      if (chosen) row.path = chosen
      row.receivedBytes = item.getReceivedBytes()
      row.totalBytes = item.getTotalBytes()
      if (state === 'interrupted') row.state = 'interrupted'
      this.upsert(row, false)
      if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; this.persist(row) }, 500)
    })
    item.once('done', (_event, state) => {
      this.active.delete(id)
      if (persistTimer) clearTimeout(persistTimer)
      const chosen = item.getSavePath()
      if (chosen) row.path = chosen
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

  /**
   * Clear the downloads list only — files already saved to disk are kept
   * (this is the established semantic: clearing history never deletes files).
   */
  clear(): void { this.rows = []; this.store.clearDownloads(); this.emit([]) }

  async open(id: string): Promise<DownloadActionResult> {
    const row = this.rows.find((item) => item.id === id && item.state === 'completed')
    if (!row) return { ok: false, error: '未找到该下载记录（可能尚未完成）' }
    if (!row.path || !fs.existsSync(row.path)) {
      return { ok: false, error: '文件已被移动或删除：' + (row.path || row.filename) }
    }
    try {
      // openPath resolves to '' on success, or a human-readable error string.
      const message = await shell.openPath(row.path)
      if (message) return { ok: false, error: message }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? '打开文件失败' }
    }
  }

  reveal(id: string): DownloadActionResult {
    const row = this.rows.find((item) => item.id === id)
    if (!row) return { ok: false, error: '未找到该下载记录' }
    if (!row.path || !fs.existsSync(row.path)) {
      return { ok: false, error: '文件已被移动或删除：' + (row.path || row.filename) }
    }
    try {
      shell.showItemInFolder(row.path)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? '定位文件失败' }
    }
  }
}
