/**
 * Trusted-host rules for imported CLI credentials, shared by the main process
 * (hard gate in auth-import) and the renderer (providers panel UI), so both
 * sides can never drift apart.
 */

/** Official hosts an imported OAuth credential may be sent to, per source. */
export const OFFICIAL_IMPORT_HOSTS: Record<string, string[]> = {
  codex: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
  opencode: [
    'openrouter.ai',
    'api.anthropic.com',
    'api.openai.com',
    'generativelanguage.googleapis.com'
  ]
}

export const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isOfficialHost(hostname: string, domains: string[]): boolean {
  return domains.some((d) => hostname === d || hostname.endsWith(`.${d}`))
}

/**
 * True when the base URL is safe for an imported (likely OAuth) credential:
 * localhost is always fine, official provider domains are fine, everything
 * else needs an explicit opt-in (`allowCustomHost`).
 */
export function isTrustedImportedHost(baseUrl: string, source?: string): boolean {
  let hostname = ''
  try {
    hostname = new URL((baseUrl ?? '').trim()).hostname.toLowerCase()
  } catch {
    return false
  }
  if (!hostname) return false
  if (LOCAL_HOSTNAMES.has(hostname)) return true
  if (source === 'codex' || source === 'opencode') {
    return isOfficialHost(hostname, OFFICIAL_IMPORT_HOSTS[source])
  }
  return false
}

/** Host portion of a URL, or '' when unparsable (for UI checks). */
export function hostOfUrl(baseUrl: string): string {
  try {
    return new URL((baseUrl ?? '').trim()).hostname.toLowerCase()
  } catch {
    return ''
  }
}
