/**
 * 跨重启断点续传的"半成品登记表"。
 *
 * 为什么需要它：Electron 的 `DownloadItem.canResume()/resume()` 只在**同一进程内**
 * 有效——退出应用后未完成的下载就作废了。要真的"明天接着下"，必须自己保存
 * 中断时的临时文件位置与元数据，重启后用 Range 请求续剩下的字节。
 *
 * 这个模块只做纯文件逻辑（不依赖 electron），因此可以直接单测。
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../shared/atomic'

export interface PartialMeta {
  id: string
  url: string
  /** 完成后应该落到哪里。 */
  target: string
  /** 已下载部分的临时文件（Chromium 的 .crdownload 会被改名到这里）。 */
  temp: string
  receivedBytes: number
  totalBytes: number
  /** 服务端校验器，用于 `If-Range`：文件变了就不能续，要整下。 */
  etag?: string
  lastModified?: string
  updatedAt: number
}

const MAX_ENTRIES = 50

function isPartial(value: unknown): value is PartialMeta {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<PartialMeta>
  return (
    typeof v.id === 'string' &&
    typeof v.url === 'string' &&
    typeof v.target === 'string' &&
    typeof v.temp === 'string' &&
    typeof v.receivedBytes === 'number' &&
    typeof v.updatedAt === 'number'
  )
}

export class PartialDownloadStore {
  private file: string
  private items = new Map<string, PartialMeta>()

  constructor(directory: string) {
    this.file = path.join(directory, 'download-partials.json')
    this.items = this.load()
  }

  private load(): Map<string, PartialMeta> {
    const out = new Map<string, PartialMeta>()
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      return out
    }
    try {
      const parsed = JSON.parse(raw) as { items?: unknown }
      const list = Array.isArray(parsed?.items) ? parsed.items : []
      for (const entry of list) {
        if (!isPartial(entry)) continue
        // 临时文件没了就没法续，直接丢弃（避免用户看到永远失败的"继续"）
        try {
          const stat = fs.statSync(entry.temp)
          if (!stat.isFile() || stat.size === 0) continue
          out.set(entry.id, { ...entry, receivedBytes: stat.size })
        } catch {
          continue
        }
      }
    } catch {
      console.error('[downloads] 续传登记表解析失败，已忽略')
    }
    return out
  }

  private save(): void {
    try {
      const items = [...this.items.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_ENTRIES)
      writeFileAtomic(this.file, JSON.stringify({ items }, null, 2))
    } catch (error) {
      console.error('[downloads] 续传登记表保存失败：', (error as Error)?.message ?? error)
    }
  }

  put(meta: PartialMeta): void {
    // 以临时文件的真实大小为准：续传的起点必须和磁盘上的数据一致，
    // 否则 Range 起点偏移会让文件内容错位
    let receivedBytes = meta.receivedBytes
    try {
      receivedBytes = fs.statSync(meta.temp).size
    } catch {
      /* 临时文件不可用就先信调用方给的值 */
    }
    this.items.set(meta.id, { ...meta, receivedBytes })
    this.save()
  }

  get(id: string): PartialMeta | null {
    const found = this.items.get(id)
    return found ? { ...found } : null
  }

  list(): PartialMeta[] {
    return [...this.items.values()].map((m) => ({ ...m }))
  }

  remove(id: string): void {
    if (!this.items.delete(id)) return
    this.save()
  }

  /** 删掉登记项与临时文件（下载完成或用户取消时）。 */
  discard(id: string): void {
    const meta = this.items.get(id)
    this.items.delete(id)
    this.save()
    if (!meta) return
    try {
      fs.rmSync(meta.temp, { force: true })
    } catch {
      /* 临时文件可能已被重命名 */
    }
  }
}
