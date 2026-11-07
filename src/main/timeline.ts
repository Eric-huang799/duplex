/**
 * AI 操作时间线：把"AI 在页面上做了什么"落盘成一条可回看、可导出的流水。
 *
 * 三个刻意的设计选择：
 *  - **追加写（append-only NDJSON）**，不是全量重写。会话存储那种"每次防抖都
 *    parse + stringify + 写整个文件"的做法在长会话里会持续占用主线程，这里不重复。
 *  - **轮转保留一代**：超过上限就整体转存成 `.1`，旧一代被覆盖。既不无限增长，
 *    也不至于一次写坏就把历史全丢。
 *  - **永不抛错**：时间线是旁路审计，任何写失败都只记一行日志，不能影响 AI 任务本身。
 */
import fs from 'node:fs'
import path from 'node:path'

export type TimelineKind = 'tool' | 'takeover' | 'resume' | 'emergency'

export interface TimelineEntry {
  ts: number
  kind: TimelineKind
  tabId?: number
  /** 工具名（kind === 'tool'）。 */
  name?: string
  /** 成功/失败（kind === 'tool'）。 */
  ok?: boolean
  /** 自由补充：失败摘要、暂停原因等。 */
  detail?: string
}

const MAX_BYTES = 2 * 1024 * 1024
const DETAIL_LIMIT = 240

function clip(value: string | undefined): string | undefined {
  if (!value) return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text
}

export class TimelineStore {
  private file: string
  private rotated: string

  constructor(directory: string) {
    this.file = path.join(directory, 'timeline.jsonl')
    this.rotated = `${this.file}.1`
  }

  get filePath(): string {
    return this.file
  }

  private rotateIfNeeded(incoming: number): void {
    try {
      const stat = fs.statSync(this.file)
      if (stat.size + incoming <= MAX_BYTES) return
      fs.renameSync(this.file, this.rotated)
    } catch {
      /* 文件还不存在，或轮转失败——继续追加即可 */
    }
  }

  record(entry: Omit<TimelineEntry, 'ts'> & { ts?: number }): void {
    try {
      const safe: TimelineEntry = {
        ts: entry.ts ?? Date.now(),
        kind: entry.kind,
        ...(entry.tabId != null ? { tabId: entry.tabId } : {}),
        ...(entry.name ? { name: entry.name } : {}),
        ...(entry.ok != null ? { ok: entry.ok } : {}),
        ...(entry.detail ? { detail: clip(entry.detail) as string } : {})
      }
      const line = `${JSON.stringify(safe)}\n`
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      this.rotateIfNeeded(Buffer.byteLength(line, 'utf8'))
      fs.appendFileSync(this.file, line, 'utf8')
    } catch (error) {
      console.error('[timeline] 记录失败：', (error as Error)?.message ?? error)
    }
  }

  /** 最近 N 条，最新在前。文件不存在或全坏时返回空数组。 */
  recent(limit = 100): TimelineEntry[] {
    const count = Math.max(1, Math.min(2000, Math.floor(limit)))
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const lines = raw.split('\n').filter((line) => line.trim().length > 0)
      const out: TimelineEntry[] = []
      for (const line of lines.slice(-count)) {
        try {
          out.push(JSON.parse(line) as TimelineEntry)
        } catch {
          /* 坏行（例如被截断的最后一行）直接跳过 */
        }
      }
      return out.reverse()
    } catch {
      return []
    }
  }

  /** 导出成 Markdown（按时间正序，便于阅读）。 */
  toMarkdown(limit = 300): string {
    const entries = this.recent(limit).slice().reverse()
    const lines: string[] = ['# Duplex AI 操作时间线', '']
    if (entries.length === 0) {
      lines.push('_还没有记录。_')
      return `${lines.join('\n')}\n`
    }
    lines.push(`共 ${entries.length} 条，导出时间 ${new Date().toISOString()}`, '')
    lines.push('| 时间 | 类型 | 目标 | 结果 |')
    lines.push('| --- | --- | --- | --- |')
    for (const entry of entries) {
      const when = new Date(entry.ts).toLocaleString()
      const kind =
        entry.kind === 'tool'
          ? '工具'
          : entry.kind === 'takeover'
            ? '人工接管'
            : entry.kind === 'resume'
              ? '交回 AI'
              : '急停'
      const target = entry.name ?? (entry.tabId != null ? `标签 ${entry.tabId}` : '—')
      const result =
        entry.ok == null ? (entry.detail ?? '—') : `${entry.ok ? '成功' : '失败'}${entry.detail ? `：${entry.detail}` : ''}`
      lines.push(`| ${when} | ${kind} | ${target} | ${result.replace(/\|/g, '\\|')} |`)
    }
    return `${lines.join('\n')}\n`
  }
}
