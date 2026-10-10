/**
 * Omnibox suggestion ranking + history date grouping.
 * Pure logic shared by the renderer address bar, the recent-history popup,
 * the library panel and the unit tests (Chrome-style interaction patterns).
 */
import type { BookmarkRecord, HistoryRecord } from './protocol'

export interface OmniboxSuggestion {
  kind: 'search' | 'history' | 'bookmark'
  /** Primary text: search terms or page title. */
  label: string
  /** Secondary text: url, or the engine name for search rows. */
  sub: string
  /** Navigation target; search rows carry the raw query for resolveAddress. */
  url: string
}

export interface OmniboxOptions {
  engineName?: string
  historyLimit?: number
  bookmarkLimit?: number
  /** Max rows for the empty-input "recent history" view. */
  recentLimit?: number
}

const DEFAULTS: Required<OmniboxOptions> = {
  engineName: '百度',
  historyLimit: 5,
  bookmarkLimit: 3,
  recentLimit: 8
}

/** Dedupe by url keeping the newest visit; result is newest-first. */
function dedupeHistory(history: HistoryRecord[]): HistoryRecord[] {
  const seen = new Map<string, HistoryRecord>()
  for (const r of history) {
    const cur = seen.get(r.url)
    if (!cur || cur.visitedAt < r.visitedAt) seen.set(r.url, r)
  }
  return [...seen.values()].sort((a, b) => b.visitedAt - a.visitedAt)
}

/** Chrome-style scoring: title hits outrank url hits. */
function matchScore(record: { title?: string; url: string }, q: string): number {
  const title = (record.title ?? '').toLowerCase()
  const url = record.url.toLowerCase()
  if (title.startsWith(q)) return 3
  if (title.includes(q)) return 2
  if (url.includes(q)) return 1
  return 0
}

function rankedMatches(records: HistoryRecord[], q: string, limit: number): HistoryRecord[] {
  return dedupeHistory(records)
    .map((r) => ({ r, score: matchScore(r, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.r.visitedAt - a.r.visitedAt)
    .slice(0, limit)
    .map((x) => x.r)
}

/**
 * Suggestions for the address bar dropdown.
 * Empty input → recent history (Chrome shows recents on focus);
 * non-empty → search row first, then bookmark hits, then history hits.
 */
export function buildOmniboxSuggestions(
  input: string,
  history: HistoryRecord[],
  bookmarks: BookmarkRecord[],
  opts: OmniboxOptions = {}
): OmniboxSuggestion[] {
  const o = { ...DEFAULTS, ...opts }
  const raw = (input ?? '').trim()
  const q = raw.toLowerCase()
  if (!q) {
    return dedupeHistory(history)
      .slice(0, o.recentLimit)
      .map((r) => ({ kind: 'history' as const, label: r.title || r.url, sub: r.url, url: r.url }))
  }
  const out: OmniboxSuggestion[] = [{ kind: 'search', label: raw, sub: `${o.engineName} 搜索`, url: raw }]
  const used = new Set<string>()
  for (const bm of bookmarks) {
    if (out.length > o.bookmarkLimit) break
    if (used.has(bm.url) || matchScore(bm, q) === 0) continue
    used.add(bm.url)
    out.push({ kind: 'bookmark', label: bm.title || bm.url, sub: bm.url, url: bm.url })
  }
  for (const r of rankedMatches(history, q, o.historyLimit + used.size)) {
    if (out.length >= 1 + o.bookmarkLimit + o.historyLimit) break
    if (used.has(r.url)) continue
    used.add(r.url)
    out.push({ kind: 'history', label: r.title || r.url, sub: r.url, url: r.url })
  }
  return out
}

export interface HistoryDayGroup {
  key: string
  label: string
  /** Newest-first records inside this group. */
  records: HistoryRecord[]
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const DAY_MS = 86_400_000

/**
 * Group history into collapsible day/month buckets:
 * 今天 / 昨天 / 星期X（近7天）/ M月（今年更早）/ YYYY年M月（往年）。
 */
export function groupHistoryByDay(history: HistoryRecord[], now = new Date()): HistoryDayGroup[] {
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = startOfDay(now)
  const sorted = [...history].filter((r) => Number.isFinite(r.visitedAt)).sort((a, b) => b.visitedAt - a.visitedAt)
  const groups = new Map<string, HistoryDayGroup>()
  for (const r of sorted) {
    const d = new Date(r.visitedAt)
    let day = startOfDay(d)
    if (day > today) day = today // future clock skew lands in 今天
    const diff = Math.round((today - day) / DAY_MS)
    let key: string
    let label: string
    if (diff === 0) {
      key = 'today'
      label = '今天'
    } else if (diff === 1) {
      key = 'yesterday'
      label = '昨天'
    } else if (diff <= 6) {
      key = `dow-${day}`
      label = WEEKDAYS[new Date(day).getDay()]
    } else if (d.getFullYear() === now.getFullYear()) {
      key = `m-${d.getFullYear()}-${d.getMonth() + 1}`
      label = `${d.getMonth() + 1}月`
    } else {
      key = `my-${d.getFullYear()}-${d.getMonth() + 1}`
      label = `${d.getFullYear()}年${d.getMonth() + 1}月`
    }
    const g = groups.get(key) ?? { key, label, records: [] }
    g.records.push(r)
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => b.records[0].visitedAt - a.records[0].visitedAt)
}
