/**
 * Omnibox suggestion ranking + history date grouping.
 * Pure logic shared by the renderer address bar, the recent-history popup,
 * the library panel and the unit tests (Chrome-style interaction patterns).
 */
import type { BookmarkRecord, HistoryRecord } from './protocol'
import { translate, type Lang } from './i18n'

export interface OmniboxSuggestion {
  kind: 'search' | 'history' | 'bookmark'
  /** Primary text: search terms or page title. */
  label: string
  /** Secondary text: url, or the engine name for search rows. */
  sub: string
  /** Navigation target; search rows carry the raw query for resolveAddress. */
  url: string
  /** Site favicon for the dropdown row (history/bookmark rows only). */
  favicon?: string
  /** Latest visit timestamp (history rows only; powers the popup time column). */
  visitedAt?: number
}

export interface OmniboxOptions {
  engineName?: string
  lang?: Lang
  historyLimit?: number
  bookmarkLimit?: number
  /** Max rows for the empty-input "recent history" view. */
  recentLimit?: number
}

const DEFAULTS: Required<Omit<OmniboxOptions, 'engineName' | 'lang'>> & { engineName: string } = {
  engineName: '',
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
  const lang = opts.lang ?? 'zh'
  const engineName = o.engineName || translate(lang, 'engine.baidu')
  const raw = (input ?? '').trim()
  const q = raw.toLowerCase()
  if (!q) {
    return dedupeHistory(history)
      .slice(0, o.recentLimit)
      .map((r) => ({
        kind: 'history' as const,
        label: r.title || r.url,
        sub: r.url,
        url: r.url,
        favicon: r.favicon,
        visitedAt: r.visitedAt
      }))
  }
  const out: OmniboxSuggestion[] = [
    { kind: 'search', label: raw, sub: translate(lang, 'omnibox.searchSub', { engine: engineName }), url: raw }
  ]
  const used = new Set<string>()
  for (const bm of bookmarks) {
    if (out.length > o.bookmarkLimit) break
    if (used.has(bm.url) || matchScore(bm, q) === 0) continue
    used.add(bm.url)
    out.push({ kind: 'bookmark', label: bm.title || bm.url, sub: bm.url, url: bm.url, favicon: bm.favicon })
  }
  for (const r of rankedMatches(history, q, o.historyLimit + used.size)) {
    if (out.length >= 1 + o.bookmarkLimit + o.historyLimit) break
    if (used.has(r.url)) continue
    used.add(r.url)
    out.push({ kind: 'history', label: r.title || r.url, sub: r.url, url: r.url, favicon: r.favicon, visitedAt: r.visitedAt })
  }
  return out
}

/**
 * Chrome-style compact url: drop the http(s):// scheme and a leading www.,
 * trim a bare root trailing slash; leave every other protocol untouched.
 */
export function stripUrlForDisplay(url: string): string {
  const m = /^https?:\/\/(.*)$/i.exec(url)
  if (!m) return url
  const rest = m[1].replace(/^www\./i, '')
  const slash = rest.indexOf('/')
  if (slash >= 0 && rest.slice(slash) === '/') return rest.slice(0, slash)
  return rest
}

export interface HighlightSegment {
  t: string
  hit: boolean
}

/** Split text so the query's first case-insensitive occurrence can render bold. */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  const t = text ?? ''
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return [{ t, hit: false }]
  const i = t.toLowerCase().indexOf(q)
  if (i < 0) return [{ t, hit: false }]
  return [
    { t: t.slice(0, i), hit: false },
    { t: t.slice(i, i + q.length), hit: true },
    { t: t.slice(i + q.length), hit: false }
  ].filter((s) => s.t.length > 0)
}

/** Compact HH:MM visit time for the recent-history popup; '' when unknown. */
export function formatVisitTime(ts?: number): string {
  if (ts === undefined || !Number.isFinite(ts)) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface HistoryDayGroup {
  key: string
  label: string
  /** Newest-first records inside this group. */
  records: HistoryRecord[]
}

const DAY_MS = 86_400_000

/**
 * Group history into collapsible day/month buckets:
 * 今天 / 昨天 / 星期X（近7天）/ M月（今年更早）/ YYYY年M月（往年）。
 */
export function groupHistoryByDay(history: HistoryRecord[], now = new Date(), lang: Lang = 'zh'): HistoryDayGroup[] {
  const weekdays = translate(lang, 'omnibox.weekdays').split(',')
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
      label = translate(lang, 'omnibox.today')
    } else if (diff === 1) {
      key = 'yesterday'
      label = translate(lang, 'omnibox.yesterday')
    } else if (diff <= 6) {
      key = `dow-${day}`
      label = weekdays[new Date(day).getDay()]
    } else if (d.getFullYear() === now.getFullYear()) {
      key = `m-${d.getFullYear()}-${d.getMonth() + 1}`
      label = translate(lang, 'omnibox.monthLabel', { m: d.getMonth() + 1 })
    } else {
      key = `my-${d.getFullYear()}-${d.getMonth() + 1}`
      label = translate(lang, 'omnibox.yearMonthLabel', { y: d.getFullYear(), m: d.getMonth() + 1 })
    }
    const g = groups.get(key) ?? { key, label, records: [] }
    g.records.push(r)
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => b.records[0].visitedAt - a.records[0].visitedAt)
}

export interface HistoryMonth {
  /** Bucket key in 'YYYY-MM' form. */
  key: string
  /** Chip label, always year-qualified: 'YYYY年M月'. */
  label: string
}

function monthKeyOf(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Distinct months that contain visits, newest first; labels always carry the year. */
export function listHistoryMonths(history: HistoryRecord[], lang: Lang = 'zh'): HistoryMonth[] {
  const seen = new Set<string>()
  for (const r of history) {
    if (Number.isFinite(r.visitedAt)) seen.add(monthKeyOf(r.visitedAt))
  }
  return [...seen]
    .sort((a, b) => (a < b ? 1 : -1))
    .map((key) => {
      const [y, m] = key.split('-')
      return { key, label: translate(lang, 'omnibox.yearMonthChip', { y, m: Number(m) }) }
    })
}

/** Keep only the visits of one month bucket; 'all' passes the list through untouched. */
export function filterHistoryByMonth(history: HistoryRecord[], key: string): HistoryRecord[] {
  if (key === 'all') return history
  return history.filter((r) => Number.isFinite(r.visitedAt) && monthKeyOf(r.visitedAt) === key)
}
