/**
 * Netscape bookmark HTML parser (Chrome/Edge/Firefox "export bookmarks").
 * Pure string→records: no Electron, no fs — unit-testable in isolation.
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
