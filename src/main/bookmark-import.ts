import fs from 'node:fs'
import path from 'node:path'

/**
 * Netscape bookmark HTML parser (Chrome/Edge/Firefox "export bookmarks").
 * Parsers are pure string→records (no Electron) — unit-testable in isolation;
 * the local-browser section at the bottom is a thin fs scanner around them.
 *
 * Folder model: the depth-1 folders (浏览器导出的「书签栏/书签菜单」工具栏根)
 * are treated as transparent — their direct children import as uncategorized.
 * Deeper folders keep their names so structure below the toolbar survives.
 */
export interface ImportedBookmark {
  url: string
  title: string
  addedAt: number
  folder?: string
}

/** Read one attribute out of a raw opening tag (e.g. `<A HREF="..." ...>`). */
function attr(openTag: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(openTag)
  return m?.[1]
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
}

export function parseNetscapeBookmarks(html: string): ImportedBookmark[] {
  const out: ImportedBookmark[] = []
  // -1 = before the outermost <DL>; folderAt[depth] = effective folder for items
  // at that nesting level (null = uncategorized).
  let dlDepth = -1
  const folderAt: Array<string | null> = []
  let pendingFolder: string | null = null

  const tokenRe =
    /<DL[^>]*>|<\/DL[^>]*>|<H3\b([^>]*)>([\s\S]*?)<\/H3>|<A\b([^>]*)>([\s\S]*?)<\/A>/gi

  for (const m of html.matchAll(tokenRe)) {
    const token = m[0].toLowerCase()
    if (token.startsWith('<dl')) {
      dlDepth++
      folderAt[dlDepth] =
        pendingFolder !== null && dlDepth > 1 ? pendingFolder : (folderAt[dlDepth - 1] ?? null)
      pendingFolder = null
    } else if (token.startsWith('</dl')) {
      dlDepth--
      if (dlDepth < -1) dlDepth = -1
    } else if (m[2] !== undefined) {
      // <H3 ...>name</H3> — folder header; applies to the next <DL>
      pendingFolder = decodeEntities(m[2].replace(/<[^>]*>/g, '')).trim() || null
    } else if (m[3] !== undefined) {
      // <A HREF="..." ADD_DATE="...">title</A>
      const href = decodeEntities((attr(m[3], 'HREF') ?? '').trim())
      if (!/^https?:\/\//i.test(href)) continue
      const addRaw = attr(m[3], 'ADD_DATE')
      let addedAt = addRaw ? Number(addRaw) * 1000 : Date.now()
      if (!Number.isFinite(addedAt) || addedAt <= 0) addedAt = Date.now()
      const title = decodeEntities((m[4] ?? '').replace(/<[^>]*>/g, '')).trim()
      const folder = dlDepth >= 0 ? folderAt[dlDepth] ?? undefined : undefined
      out.push({ url: href, title: title || href, addedAt, ...(folder ? { folder } : {}) })
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Direct import from local Chrome / Edge profiles                     */
/* ------------------------------------------------------------------ */

export interface LocalBrowserSource {
  browser: 'Chrome' | 'Edge'
  profile: string
  count: number
}

interface ChromeBookmarkNode {
  type?: string
  name?: string
  url?: string
  date_added?: string | number
  children?: ChromeBookmarkNode[]
}

/** Chrome timestamps are microseconds since 1601-01-01 UTC. */
export function chromeTimeToMs(raw: unknown): number {
  const us = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(us) || us <= 11644473600000000) return Date.now()
  return (us - 11644473600000000) / 1000
}

/**
 * Parse one Chrome/Edge `Bookmarks` JSON file into flat records. Every
 * folder path is prefixed with `label` (e.g. "Chrome" / "Edge Profile 1")
 * so imported structure stays attributable in the app's flat folder list.
 */
export function parseChromeBookmarksJson(json: string, label: string): ImportedBookmark[] {
  let data: { roots?: Record<string, ChromeBookmarkNode> } | null = null
  try {
    data = JSON.parse(json) as { roots?: Record<string, ChromeBookmarkNode> }
  } catch {
    return []
  }
  const out: ImportedBookmark[] = []
  const walk = (node: ChromeBookmarkNode | undefined, chain: string[]): void => {
    if (!node || typeof node !== 'object') return
    if (typeof node.url === 'string' && node.url) {
      if (/^https?:\/\//i.test(node.url)) {
        const title = (node.name ?? '').trim()
        out.push({
          url: node.url,
          title: title || node.url,
          addedAt: chromeTimeToMs(node.date_added),
          ...(chain.length > 0 ? { folder: chain.join(' / ') } : {})
        })
      }
      return
    }
    const next =
      typeof node.name === 'string' && node.name.trim() ? [...chain, node.name.trim()] : chain
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child, next)
  }
  for (const rootName of ['bookmark_bar', 'other', 'synced']) {
    walk(data?.roots?.[rootName], [label])
  }
  return out
}

/**
 * Scan every installed Chrome/Edge profile on this machine for its
 * Bookmarks JSON. Missing browsers / profiles are silently skipped.
 */
export function scanLocalBrowserBookmarks(localAppData: string): {
  sources: LocalBrowserSource[]
  records: ImportedBookmark[]
} {
  const targets: Array<{ browser: 'Chrome' | 'Edge'; segments: string[] }> = [
    { browser: 'Chrome', segments: ['Google', 'Chrome', 'User Data'] },
    { browser: 'Edge', segments: ['Microsoft', 'Edge', 'User Data'] }
  ]
  const sources: LocalBrowserSource[] = []
  const records: ImportedBookmark[] = []
  for (const { browser, segments } of targets) {
    const userData = path.join(localAppData, ...segments)
    let entries: string[] = []
    try {
      entries = fs.readdirSync(userData)
    } catch {
      continue // browser not installed
    }
    for (const entry of entries) {
      if (entry !== 'Default' && !/^Profile \d+$/.test(entry)) continue
      let json: string
      try {
        json = fs.readFileSync(path.join(userData, entry, 'Bookmarks'), 'utf8')
      } catch {
        continue // profile has no bookmarks file
      }
      const parsed = parseChromeBookmarksJson(
        json,
        entry === 'Default' ? browser : `${browser} ${entry}`
      )
      if (parsed.length > 0) {
        sources.push({ browser, profile: entry, count: parsed.length })
        records.push(...parsed)
      }
    }
  }
  return { sources, records }
}
