/**
 * Credential import from CLI tools already logged in on this machine
 * (Codex / opencode). Strictly read-only: we never write back, so we can
 * never race with the CLI's own token refresh. Pure logic, unit-testable.
 *
 * Sources:
 *  - codex:    ~/.codex/auth.json
 *              { auth_mode, OPENAI_API_KEY, tokens: { access_token, ... }, last_refresh }
 *  - opencode: $XDG_DATA_HOME/opencode/auth.json, falling back to
 *              ~/.local/share/opencode/auth.json when XDG_DATA_HOME is unset
 *              { [provider]: { type: 'oauth', access, refresh, expires (epoch ms) }
 *                           | { type: 'api', key } }
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ImportSource = 'codex' | 'opencode'

export interface ImportedKeyResult {
  ok: boolean
  apiKey?: string
  error?: string
  /** epoch ms; undefined = 未知/不过期 */
  expiresAt?: number
}

export interface ImportStatus {
  found: boolean
  path: string
  /** 已登录/可用的 provider 名称列表 */
  providers: string[]
  expiresAt?: number
  /** 凭据有效期不足 24 小时（含已过期）时为 true，供 UI 提前提示重新登录。 */
  expiringSoon?: true
  error?: string
}

/** Minimal provider shape needed to check an imported-credential endpoint. */
export interface ImportedEndpointProvider {
  authType?: string
  authSource?: string
  baseUrl?: string
  allowCustomHost?: boolean
}

const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000

/** Official hosts an imported OAuth credential may be sent to. */
const OFFICIAL_IMPORT_HOSTS: Record<ImportSource, string[]> = {
  codex: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
  opencode: [
    'openrouter.ai',
    'api.anthropic.com',
    'api.openai.com',
    'generativelanguage.googleapis.com'
  ]
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const CODEX_EXPIRED = 'Codex 凭据已过期，请先运行一次 codex CLI 刷新'
const OPENCODE_EXPIRED = 'opencode 凭据已过期，请先运行一次 opencode CLI 刷新'

/** Credential file location, always relative to os.homedir() (no hardcoded users). */
function authFilePath(source: ImportSource): string {
  switch (source) {
    case 'codex':
      return path.join(os.homedir(), '.codex', 'auth.json')
    case 'opencode': {
      // opencode resolves its data dir through xdg-basedir: XDG_DATA_HOME wins,
      // otherwise ~/.local/share.
      const xdg = (process.env['XDG_DATA_HOME'] ?? '').trim()
      const dataHome = xdg || path.join(os.homedir(), '.local', 'share')
      return path.join(dataHome, 'opencode', 'auth.json')
    }
    default:
      return ''
  }
}

function isOfficialHost(hostname: string, domains: string[]): boolean {
  return domains.some((d) => hostname === d || hostname.endsWith(`.${d}`))
}

/**
 * True when the base URL is safe for an imported (likely OAuth) credential:
 * localhost is always fine, official provider domains are fine, everything
 * else needs an explicit opt-in (`allowCustomHost`) checked by the caller.
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

/**
 * Hard gate for imported credentials: refuse to send a CLI-imported OAuth
 * token to a custom gateway unless the user explicitly trusted it. Key-mode
 * providers are unaffected.
 */
export function assertTrustedImportedEndpoint(provider: ImportedEndpointProvider): void {
  if (provider.authType !== 'import') return
  if (provider.allowCustomHost === true) return
  if (isTrustedImportedHost(provider.baseUrl ?? '', provider.authSource)) return
  throw new Error(
    '导入的 OAuth 凭据只能发往官方域名；如确认信任该网关，请在模型配置中勾选「我信任此网关」'
  )
}

/** Read + parse a JSON file; all failures become a Chinese message, never a throw. */
function readJsonFile(
  file: string,
  label: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') {
      return { ok: false, error: `未找到 ${label} 凭据文件（${file}），请先运行一次 ${label} CLI 登录` }
    }
    return { ok: false, error: `${label} 凭据文件无法读取或解析（${file}）` }
  }
}

/** Decode a JWT payload (base64url, signature NOT verified) and return `exp` as epoch ms. */
function jwtExpiresAt(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) && claims.exp > 0
      ? claims.exp * 1000
      : undefined
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function resolveCodex(): ImportedKeyResult {
  const read = readJsonFile(authFilePath('codex'), 'Codex')
  if (!read.ok) return { ok: false, error: read.error }
  const data = asRecord(read.value)
  const tokens = asRecord(data.tokens)
  const access = typeof tokens.access_token === 'string' ? tokens.access_token : ''
  const apiKey = typeof data.OPENAI_API_KEY === 'string' ? data.OPENAI_API_KEY : ''
  const mode = typeof data.auth_mode === 'string' ? data.auth_mode : ''

  // API-key mode never expires; honour it even if stale tokens linger in the file.
  if (mode === 'apikey' && apiKey) return { ok: true, apiKey }
  if (access) {
    const expiresAt = jwtExpiresAt(access)
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      return { ok: false, error: CODEX_EXPIRED }
    }
    return { ok: true, apiKey: access, expiresAt }
  }
  if (apiKey) return { ok: true, apiKey }
  return { ok: false, error: '未找到可用的 Codex 凭据，请先运行一次 codex CLI 登录' }
}

function isOpencodeEntry(value: unknown): value is Record<string, unknown> {
  const type = asRecord(value).type
  return type === 'oauth' || type === 'api'
}

/** Pick one opencode credential entry: by name, else first oauth, else first api. */
function pickOpencodeEntry(
  data: Record<string, unknown>,
  providerName?: string
): { ok: true; name: string; entry: Record<string, unknown> } | { ok: false; error: string } {
  if (providerName) {
    const entry = data[providerName]
    if (!isOpencodeEntry(entry)) {
      return {
        ok: false,
        error: `opencode 中未找到 provider "${providerName}" 的凭据，请先运行一次 opencode CLI 登录`
      }
    }
    return { ok: true, name: providerName, entry }
  }
  const names = Object.keys(data).filter((n) => isOpencodeEntry(data[n]))
  const name = names.find((n) => data[n] && (data[n] as Record<string, unknown>).type === 'oauth') ?? names[0]
  if (!name) {
    return { ok: false, error: '未找到可用的 opencode 凭据，请先运行一次 opencode CLI 登录' }
  }
  return { ok: true, name, entry: data[name] as Record<string, unknown> }
}

function resolveOpencode(providerName?: string): ImportedKeyResult {
  const read = readJsonFile(authFilePath('opencode'), 'opencode')
  if (!read.ok) return { ok: false, error: read.error }
  const picked = pickOpencodeEntry(asRecord(read.value), providerName)
  if (!picked.ok) return { ok: false, error: picked.error }
  const { name, entry } = picked

  if (entry.type === 'oauth') {
    const access = typeof entry.access === 'string' ? entry.access : ''
    if (!access) {
      return {
        ok: false,
        error: `opencode provider "${name}" 的 OAuth 凭据不完整，请先运行一次 opencode CLI 重新登录`
      }
    }
    // opencode stores `expires` as epoch ms (Date.now() + expires_in * 1000).
    const expiresAt =
      typeof entry.expires === 'number' && Number.isFinite(entry.expires) && entry.expires > 0
        ? entry.expires
        : undefined
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      return { ok: false, error: OPENCODE_EXPIRED }
    }
    return { ok: true, apiKey: access, expiresAt }
  }

  const key = typeof entry.key === 'string' ? entry.key : ''
  if (!key) return { ok: false, error: `opencode provider "${name}" 没有可用的 API key` }
  return { ok: true, apiKey: key }
}

/** Read and return a usable key. Expired credentials return ok:false and ask to run the CLI first. */
export function resolveImportedKey(source: ImportSource, providerName?: string): ImportedKeyResult {
  try {
    if (source === 'codex') return resolveCodex()
    if (source === 'opencode') return resolveOpencode(providerName)
    return { ok: false, error: `不支持的凭据来源: ${String(source)}` }
  } catch {
    return { ok: false, error: '读取凭据时发生未知错误' }
  }
}

function codexStatus(): ImportStatus {
  const file = authFilePath('codex')
  const read = readJsonFile(file, 'Codex')
  if (!read.ok) return { found: false, path: file, providers: [], error: read.error }
  const data = asRecord(read.value)
  const tokens = asRecord(data.tokens)
  const access = typeof tokens.access_token === 'string' ? tokens.access_token : ''
  const apiKey = typeof data.OPENAI_API_KEY === 'string' ? data.OPENAI_API_KEY : ''

  const providers: string[] = []
  if (access) providers.push('chatgpt')
  if (apiKey) providers.push('apikey')

  const status: ImportStatus = { found: true, path: file, providers }
  if (access) {
    const expiresAt = jwtExpiresAt(access)
    if (expiresAt !== undefined) status.expiresAt = expiresAt
  }
  // Keep the status error consistent with what resolveImportedKey would return.
  const resolved = resolveCodex()
  if (!resolved.ok) status.error = resolved.error
  return status
}

function opencodeStatus(): ImportStatus {
  const file = authFilePath('opencode')
  const read = readJsonFile(file, 'opencode')
  if (!read.ok) return { found: false, path: file, providers: [], error: read.error }
  const data = asRecord(read.value)
  const providers = Object.keys(data).filter((n) => isOpencodeEntry(data[n]))

  const status: ImportStatus = { found: true, path: file, providers }
  const picked = pickOpencodeEntry(data)
  if (picked.ok) {
    const { entry } = picked
    if (entry.type === 'oauth' && typeof entry.expires === 'number' && Number.isFinite(entry.expires)) {
      status.expiresAt = entry.expires
    }
    const resolved = resolveOpencode()
    if (!resolved.ok) status.error = resolved.error
  } else {
    status.error = picked.error
  }
  return status
}

/** UI-facing status without any secret values. Never throws. */
export function importStatus(source: ImportSource): ImportStatus {
  let status: ImportStatus
  try {
    const file = authFilePath(source)
    if (source === 'codex') status = codexStatus()
    else if (source === 'opencode') status = opencodeStatus()
    else status = { found: false, path: file, providers: [], error: `不支持的凭据来源: ${String(source)}` }
  } catch {
    status = { found: false, path: '', providers: [], error: '读取凭据时发生未知错误' }
  }
  if (status.expiresAt !== undefined && status.expiresAt - Date.now() < EXPIRING_SOON_MS) {
    status.expiringSoon = true
  }
  return status
}
