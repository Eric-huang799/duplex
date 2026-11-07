import { app, shell, type DownloadItem, type Session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { mt } from './i18n'
import type { BrowserDataStore, DownloadRecord } from './browser-data'
import { PartialDownloadStore } from './download-partials'
import { adoptChromiumPartial, resumePartial } from './download-resume'

/** Structured result shared by downloadsOpen / downloadsReveal (surfaced over IPC). */
export interface DownloadActionResult {
  ok: boolean
  error?: string
}

export class DownloadManager {
  private active = new Map<string, DownloadItem>()
  private rows: DownloadRecord[]
  /** 每个下载的自动续传尝试次数（上限 2 次，避免对不支持 Range 的服务端反复重试）。 */
  private resumeAttempts = new Map<string, number>()

  constructor(
    private session: Session,
    private store: BrowserDataStore,
    private emit: (rows: DownloadRecord[]) => void,
    /**
     * When true, leave the save path to Electron so the native Save dialog
     * appears; when false, auto-save into the downloads directory (unique name).
     * Defaults to asking, matching the settings default.
     */
    private getConfirmBeforeDownload: () => boolean = () => true,
    /** 跨重启续传的登记表（可选：没有它也能用会话内原生续传）。 */
    private partials?: PartialDownloadStore
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
      if (state === 'interrupted') {
        row.state = 'interrupted'
        // 原生续传：Chromium 自己按 Range 续，条件是服务端支持分段
        this.scheduleAutoResume(id, item)
        // 跨重启续传：把 Chromium 的半成品改名收编，登记元数据
        this.rememberPartial(id, item, row)
      }
      this.upsert(row, false)
      if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; this.persist(row) }, 500)
    })
    item.once('done', (_event, state) => {
      this.active.delete(id)
      this.resumeAttempts.delete(id)
      if (persistTimer) clearTimeout(persistTimer)
      const chosen = item.getSavePath()
      if (chosen) row.path = chosen
      row.receivedBytes = item.getReceivedBytes()
      row.totalBytes = item.getTotalBytes()
      row.endedAt = Date.now()
      row.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      if (state === 'completed' || state === 'cancelled') this.partials?.discard(id)
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

  /**
   * 中断后自动续传（退避 1s → 3s，最多 2 次）。
   * `canResume()` 为 false 时说明服务端不支持分段请求或已无法续传，直接放弃。
   */
  private scheduleAutoResume(id: string, item: DownloadItem): void {
    const attempts = this.resumeAttempts.get(id) ?? 0
    if (attempts >= 2) return
    let canResume = false
    try {
      canResume = item.canResume()
    } catch {
      canResume = false
    }
    if (!canResume) return
    this.resumeAttempts.set(id, attempts + 1)
    const timer = setTimeout(
      () => {
        try {
          if (item.canResume()) item.resume()
        } catch {
          /* 续传失败会再次进入 interrupted，本轮到此为止 */
        }
      },
      attempts === 0 ? 1000 : 3000
    )
    timer.unref?.()
  }

  /** 记下半成品，供重启后继续。 */
  private rememberPartial(id: string, item: DownloadItem, row: DownloadRecord): void {
    if (!this.partials) return
    let target = row.path
    try {
      target = item.getSavePath() || target
    } catch {
      /* 中断后部分接口会抛错，退回它自己记的路径 */
    }
    if (!target) return
    const temp = adoptChromiumPartial(target, id)
    if (!temp) return
    let etag: string | undefined
    let lastModified: string | undefined
    try {
      etag = item.getETag() || undefined
    } catch {
      /* 不可用 */
    }
    try {
      lastModified = item.getLastModifiedTime() || undefined
    } catch {
      /* 不可用 */
    }
    this.partials.put({
      id,
      url: item.getURL(),
      target,
      temp,
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
      updatedAt: Date.now()
    })
  }

  /** 手动续传一个中断的下载；服务端不支持 Range 请求时返回失败原因。 */
  resume(id: string): DownloadActionResult {
    // 1) 本次会话内还在的下载：走 Chromium 原生续传
    const item = this.active.get(id)
    if (item) {
      try {
        if (!item.canResume()) return { ok: false, error: mt('dl.cannotResume') }
        item.resume()
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error)?.message ?? mt('dl.resumeFailed') }
      }
    }
    // 2) 重启之后：用登记的半成品 + Range 请求自己续
    const meta = this.partials?.get(id)
    if (!meta) return { ok: false, error: mt('dl.cannotResume') }
    const row = this.rows.find((entry) => entry.id === id)
    if (row) {
      row.state = 'progressing'
      this.upsert(row)
    }
    void resumePartial(meta, (received) => {
      if (!row) return
      row.receivedBytes = received
      this.upsert(row, false)
    }).then((result) => {
      if (!row) return
      if (result.ok) {
        row.state = 'completed'
        if (row.totalBytes > 0) row.receivedBytes = row.totalBytes
        row.endedAt = Date.now()
        this.partials?.discard(id)
      } else {
        row.state = 'interrupted'
      }
      this.upsert(row)
    })
    return { ok: true }
  }

  /** 该下载当前是否可续传（界面据此决定是否显示"继续"）。 */
  canResume(id: string): boolean {
    const item = this.active.get(id)
    if (!item) return false
    try {
      return item.canResume()
    } catch {
      return false
    }
  }

  list(): DownloadRecord[] { return this.rows.map((row) => ({ ...row })) }
  cancel(id: string): boolean { const item = this.active.get(id); if (!item) return false; item.cancel(); return true }

  /**
   * Clear the downloads list only — files already saved to disk are kept
   * (this is the established semantic: clearing history never deletes files).
   */
  clear(): void { this.rows = []; this.store.clearDownloads(); this.emit([]) }

  async open(id: string): Promise<DownloadActionResult> {
    const row = this.rows.find((item) => item.id === id && item.state === 'completed')
    if (!row) return { ok: false, error: mt('dl.notFoundPending') }
    if (!row.path || !fs.existsSync(row.path)) {
      return { ok: false, error: mt('dl.fileMoved', { path: row.path || row.filename }) }
    }
    try {
      // openPath resolves to '' on success, or a human-readable error string.
      const message = await shell.openPath(row.path)
      if (message) return { ok: false, error: message }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? mt('dl.openFailed') }
    }
  }

  reveal(id: string): DownloadActionResult {
    const row = this.rows.find((item) => item.id === id)
    if (!row) return { ok: false, error: mt('dl.notFound') }
    if (!row.path || !fs.existsSync(row.path)) {
      return { ok: false, error: mt('dl.fileMoved', { path: row.path || row.filename }) }
    }
    try {
      shell.showItemInFolder(row.path)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? mt('dl.revealFailed') }
    }
  }
}
