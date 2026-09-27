/** URL normalization and address resolution (URL vs search query). */

const HAS_PROTOCOL = /^[a-z][a-z0-9+.-]*:/i
const LOCALHOST = /^localhost(:\d+)?([/?#]|$)/i
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?([/?#]|$)/
const DOMAIN = /^([\w-]+\.)+[a-z][a-z0-9-]{1,}(:\d+)?([/?#].*)?$/i

/** Legacy helper: force a string into a URL (kept for compatibility). */
export function normalizeUrl(input: string): string {
  const r = resolveAddress(input)
  return r.kind === 'url' ? r.url : 'about:blank'
}

export type ResolvedAddress =
  | { kind: 'url'; url: string }
  | { kind: 'search'; query: string }

/**
 * Decide whether user input is a URL (open directly) or a search query.
 * "example.com" -> URL; "example.com 教程" / "python 教程" / "c++" -> search.
 */
export function resolveAddress(input: string): ResolvedAddress {
  const s = (input ?? '').trim()
  if (!s) return { kind: 'url', url: 'about:blank' }
  if (LOCALHOST.test(s)) return { kind: 'url', url: 'http://' + s }
  if (IPV4.test(s)) return { kind: 'url', url: 'http://' + s }
  if (HAS_PROTOCOL.test(s)) return { kind: 'url', url: s }
  if (s.startsWith('//')) return { kind: 'url', url: 'https:' + s }
  if (!/\s/.test(s) && DOMAIN.test(s)) return { kind: 'url', url: 'https://' + s }
  return { kind: 'search', query: s }
}
