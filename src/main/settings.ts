/** Persistent app settings (~/.cobrowse/settings.json). */
import fs from 'node:fs'
import path from 'node:path'
import { cobrowseDir } from '../shared/endpoint'
import {
  normalizeProviderState,
  type AgentProvider,
  type AuthSource,
  type AuthType
} from './agent/providers'
import type { LlmProtocol } from '../shared/llm'
import { DEFAULT_ENGINE, SEARCH_ENGINES, type SearchEngine } from '../shared/search'
import { normalizeBinding } from '../shared/hotkeys'
import { isShortcutAction } from '../shared/shortcuts'
import { isValidLangSetting, type LangSetting } from '../shared/i18n'
import { mt } from './i18n'

/** Default global emergency-stop hotkeys (parsed as hotkey combos, e.g. "F2" / "Ctrl+Shift+K"). */
export const DEFAULT_STOP_KEYS = ['F2', 'Ctrl+Shift+K']

export type ThemeSetting = 'system' | 'light' | 'dark'

export interface SavedSession {
  id: string
  title: string
}

/** Result shape shared by every settings writer (surfaced over IPC). */
export interface SaveResult {
  ok: boolean
  error?: string
}

/** Runtime shape consumed by the agent loop (built from the active provider). */
export interface AgentConfig {
  baseUrl: string
  apiKey: string
  model: string
  protocol: LlmProtocol
  authType: AuthType
  authSource?: AuthSource
  /** Provider display name (used to select an opencode credential entry). */
  providerName: string
  /** Allow a non-standard/self-hosted host for this provider. */
  allowCustomHost?: boolean
  /** Per-provider streaming idle timeout in milliseconds. */
  idleTimeoutMs?: number
}

const cache: {
  theme: ThemeSetting
  language: LangSetting
  session: SavedSession | null
  agentProviders: AgentProvider[]
  activeProviderId: string | null
  searchEngine: SearchEngine
  emergencyStopKeys: string[]
  confirmBeforeDownload: boolean
  adblockEnabled: boolean
  aiPaused: boolean
  agentAutoContinueRounds: number
  shortcuts: Record<string, string>
} = {
  theme: 'system',
  language: 'system',
  session: null,
  agentProviders: [],
  activeProviderId: null,
  searchEngine: DEFAULT_ENGINE,
  emergencyStopKeys: [...DEFAULT_STOP_KEYS],
  confirmBeforeDownload: true,
  adblockEnabled: true,
  aiPaused: false,
  agentAutoContinueRounds: 0,
  shortcuts: {}
}

function settingsPath(): string {
  return path.join(cobrowseDir(), 'settings.json')
}

function backupPath(): string {
  return `${settingsPath()}.bak`
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* not JSON */
  }
  return null
}

function readBackup(): Record<string, unknown> | null {
  try {
    return parseObject(fs.readFileSync(backupPath(), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Read the raw settings object. A missing file is a fresh install ({});
 * an unreadable/corrupt file falls back to settings.json.bak; when the
 * backup is unusable too it throws so callers never overwrite good data
 * with an empty object.
 */
function readRaw(): Record<string, unknown> {
  let text: string
  try {
    text = fs.readFileSync(settingsPath(), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
  const parsed = parseObject(text)
  if (parsed) return parsed
  const recovered = readBackup()
  if (recovered) {
    console.error('[settings] settings.json 解析失败，已回退读取 settings.json.bak')
    return recovered
  }
  throw new Error('设置文件损坏且备份不可用：' + settingsPath())
}

/** Copy the current settings file to settings.json.bak (non-empty and parseable only). */
function refreshBackup(): void {
  const p = settingsPath()
  let stat: fs.Stats
  try {
    stat = fs.statSync(p)
  } catch {
    return
  }
  if (!stat.isFile() || stat.size === 0) return
  try {
    if (!parseObject(fs.readFileSync(p, 'utf8'))) {
      // never let a corrupt file replace a usable backup
      console.error('[settings] 当前设置文件无法解析，保留已有 settings.json.bak 不覆盖')
      return
    }
    fs.copyFileSync(p, backupPath())
  } catch {
    /* a failed backup must not block saving */
  }
}

/** 收集一份设置里所有非空的 apiKey，用于判断"密钥是否被清除/轮换"。 */
function collectApiKeys(data: Record<string, unknown> | null): Set<string> {
  const out = new Set<string>()
  if (!data) return out
  const providers = Array.isArray(data.agentProviders)
    ? (data.agentProviders as Array<Record<string, unknown>>)
    : []
  for (const provider of providers) {
    const key = provider?.apiKey
    if (typeof key === 'string' && key.trim()) out.add(key.trim())
  }
  return out
}

/**
 * 清除/轮换密钥后，旧密钥不能继续躺在 `settings.json.bak` 里。
 *
 * `refreshBackup()` 是在写新文件**之前**把旧文件复制成备份的，所以用户
 * "清除 API Key / 删除 provider"之后，被清掉的那个密钥会留在备份里；若之后
 * 不再改设置，它就永久保留——用户以为清理干净了，实际泄漏面翻倍。
 * 这里在写盘成功后检查一次：备份里存在"新设置已经没有"的密钥 → 直接用新内容
 * 覆盖备份（备份的意义是能回滚到可用状态，而不是保留已作废的凭据）。
 */
function scrubBackupSecrets(next: Record<string, unknown>): void {
  try {
    const bak = parseObject(fs.readFileSync(backupPath(), 'utf8'))
    if (!bak) return
    const nextKeys = collectApiKeys(next)
    const stale = [...collectApiKeys(bak)].filter((key) => !nextKeys.has(key))
    if (stale.length === 0) return
    fs.writeFileSync(backupPath(), JSON.stringify(next, null, 2), 'utf8')
    console.error(`[settings] 已从 settings.json.bak 清除 ${stale.length} 个不再使用的密钥`)
  } catch {
    /* 没有备份 / 写失败都不该影响保存本身 */
  }
}

/** Atomic write: same-directory tmp file + rename. */
function writeRaw(data: Record<string, unknown>): void {
  const p = settingsPath()
  const dir = path.dirname(p)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.settings-${process.pid}-${Date.now().toString(36)}.tmp`)
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, p)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* tmp cleanup is best-effort */
    }
    throw e
  }
}

function savePatch(patch: Record<string, unknown>): SaveResult {
  let current: Record<string, unknown>
  try {
    current = readRaw()
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? mt('settings.saveFailed') }
  }
  try {
    refreshBackup()
    const next = { ...current, ...patch }
    writeRaw(next)
    scrubBackupSecrets(next)
    return { ok: true }
  } catch {
    return { ok: false, error: mt('settings.saveFailed') }
  }
}

function isValidTheme(v: unknown): v is ThemeSetting {
  return v === 'system' || v === 'light' || v === 'dark'
}

/** Keep only known actions with a parseable canonical binding. */
function sanitizeShortcutOverrides(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [action, binding] of Object.entries(value as Record<string, unknown>)) {
    if (!isShortcutAction(action) || typeof binding !== 'string') continue
    const norm = normalizeBinding(binding)
    if (norm) out[action] = norm
  }
  return out
}

export function loadSettings(): {
  theme: ThemeSetting
  language: LangSetting
  session: SavedSession | null
  agentProviders: AgentProvider[]
  activeProviderId: string | null
  searchEngine: SearchEngine
  emergencyStopKeys: string[]
  confirmBeforeDownload: boolean
  adblockEnabled: boolean
  aiPaused: boolean
  agentAutoContinueRounds: number
  shortcuts: Record<string, string>
} {
  let raw: Record<string, unknown>
  try {
    raw = readRaw()
  } catch (e) {
    console.error('[settings] 读取设置失败，沿用内存中的上一份配置：', (e as Error)?.message ?? e)
    raw = {}
  }
  if (isValidTheme(raw.theme)) cache.theme = raw.theme
  if (isValidLangSetting(raw.language)) cache.language = raw.language
  if (typeof raw.searchEngine === 'string' && raw.searchEngine in SEARCH_ENGINES) {
    cache.searchEngine = raw.searchEngine as SearchEngine
  }
  if (Array.isArray(raw.emergencyStopKeys)) {
    const keys = raw.emergencyStopKeys
      .filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 32)
      .slice(0, 5)
    if (keys.length > 0) cache.emergencyStopKeys = [...new Set(keys)]
  }
  const s = raw.session as { id?: unknown; title?: unknown } | undefined
  if (s && typeof s.id === 'string' && s.id) {
    cache.session = { id: s.id, title: typeof s.title === 'string' ? s.title : '' }
  } else {
    cache.session = null
  }
  const norm = normalizeProviderState({
    providers: raw.agentProviders,
    activeProviderId: raw.activeProviderId,
    legacyAgent: raw.agent
  })
  cache.agentProviders = norm.providers
  cache.activeProviderId = norm.activeProviderId
  cache.confirmBeforeDownload =
    typeof raw.confirmBeforeDownload === 'boolean' ? raw.confirmBeforeDownload : true
  cache.adblockEnabled = typeof raw.adblockEnabled === 'boolean' ? raw.adblockEnabled : true
  cache.aiPaused = raw.aiPaused === true
  cache.agentAutoContinueRounds = Math.max(
    0,
    Math.min(
      5,
      Math.floor(typeof raw.agentAutoContinueRounds === 'number' ? raw.agentAutoContinueRounds : 0)
    )
  )
  if (raw.shortcuts !== undefined) cache.shortcuts = sanitizeShortcutOverrides(raw.shortcuts)
  return {
    theme: cache.theme,
    language: cache.language,
    session: cache.session,
    agentProviders: cache.agentProviders,
    activeProviderId: cache.activeProviderId,
    searchEngine: cache.searchEngine,
    emergencyStopKeys: cache.emergencyStopKeys,
    confirmBeforeDownload: cache.confirmBeforeDownload,
    adblockEnabled: cache.adblockEnabled,
    aiPaused: cache.aiPaused,
    agentAutoContinueRounds: cache.agentAutoContinueRounds,
    shortcuts: { ...cache.shortcuts }
  }
}

/** The runtime config for the agent loop; null when the active provider is missing. */
export function activeAgentConfig(): AgentConfig | null {
  const s = loadSettings()
  const p = s.agentProviders.find((x) => x.id === s.activeProviderId)
  if (!p) return null
  return {
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model,
    protocol: p.protocol,
    authType: p.authType,
    authSource: p.authSource,
    providerName: p.name,
    allowCustomHost: p.allowCustomHost,
    idleTimeoutMs: p.idleTimeoutMs
  }
}

export function saveTheme(theme: ThemeSetting): SaveResult {
  const r = savePatch({ theme })
  if (r.ok) cache.theme = theme
  return r
}

export function saveLanguage(language: LangSetting): SaveResult {
  const r = savePatch({ language })
  if (r.ok) cache.language = language
  return r
}

export function saveSearchEngine(engine: SearchEngine): SaveResult {
  const r = savePatch({ searchEngine: engine })
  if (r.ok) cache.searchEngine = engine
  return r
}

export function saveEmergencyStopKeys(keys: string[]): SaveResult {
  const next = [
    ...new Set(keys.filter((k) => typeof k === 'string' && k.length > 0 && k.length <= 32))
  ].slice(0, 5)
  const r = savePatch({ emergencyStopKeys: next })
  if (r.ok) cache.emergencyStopKeys = next.length > 0 ? next : [...DEFAULT_STOP_KEYS]
  return r
}

/**
 * Persist the browser shortcut overrides (action → canonical binding).
 * An empty object means every action uses its default.
 */
export function saveShortcuts(overrides: Record<string, string | null>): SaveResult {
  const next = sanitizeShortcutOverrides(overrides)
  const r = savePatch({ shortcuts: next })
  if (r.ok) cache.shortcuts = next
  return r
}

export function saveSession(session: SavedSession | null): SaveResult {
  const r = savePatch({ session })
  if (r.ok) cache.session = session
  return r
}

export function saveProviders(
  providers: AgentProvider[],
  activeProviderId: string | null
): SaveResult {
  let current: Record<string, unknown>
  try {
    current = readRaw()
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? mt('settings.saveFailed') }
  }
  try {
    refreshBackup()
    const next: Record<string, unknown> = {
      ...current,
      agentProviders: providers,
      activeProviderId
    }
    delete next.agent
    writeRaw(next)
    scrubBackupSecrets(next)
    cache.agentProviders = providers
    cache.activeProviderId = activeProviderId
    return { ok: true }
  } catch {
    return { ok: false, error: mt('settings.saveFailed') }
  }
}

/** Whether downloads should ask for a destination (default true). */
export function saveConfirmBeforeDownload(value: boolean): SaveResult {
  const r = savePatch({ confirmBeforeDownload: !!value })
  if (r.ok) cache.confirmBeforeDownload = !!value
  return r
}

/** 广告拦截总开关（默认开）。 */
export function saveAdblockEnabled(value: boolean): SaveResult {
  const r = savePatch({ adblockEnabled: !!value })
  if (r.ok) cache.adblockEnabled = !!value
  return r
}

/** Whether the AI is paused by the global emergency stop. */
export function saveAiPaused(value: boolean): SaveResult {
  const r = savePatch({ aiPaused: !!value })
  if (r.ok) cache.aiPaused = !!value
  return r
}

/** Auto-continue rounds after the 60-step agent cap (0 = off, clamped 0..5). */
export function saveAgentAutoContinueRounds(value: number): SaveResult {
  const next = Math.max(0, Math.min(5, Math.floor(Number(value) || 0)))
  const r = savePatch({ agentAutoContinueRounds: next })
  if (r.ok) cache.agentAutoContinueRounds = next
  return r
}
