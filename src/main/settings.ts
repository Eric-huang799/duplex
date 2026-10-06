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

/** Default global emergency-stop hotkeys (parsed as hotkey combos, e.g. "F2" / "Ctrl+Shift+K"). */
export const DEFAULT_STOP_KEYS = ['Escape', 'F2']

export type ThemeSetting = 'system' | 'light' | 'dark'

export interface SavedSession {
  id: string
  title: string
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
}

const cache: {
  theme: ThemeSetting
  session: SavedSession | null
  agentProviders: AgentProvider[]
  activeProviderId: string | null
  searchEngine: SearchEngine
  emergencyStopKeys: string[]
} = {
  theme: 'system',
  session: null,
  agentProviders: [],
  activeProviderId: null,
  searchEngine: DEFAULT_ENGINE,
  emergencyStopKeys: [...DEFAULT_STOP_KEYS]
}

function settingsPath(): string {
  return path.join(cobrowseDir(), 'settings.json')
}

function readRaw(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function isValidTheme(v: unknown): v is ThemeSetting {
  return v === 'system' || v === 'light' || v === 'dark'
}

export function loadSettings(): {
  theme: ThemeSetting
  session: SavedSession | null
  agentProviders: AgentProvider[]
  activeProviderId: string | null
  searchEngine: SearchEngine
  emergencyStopKeys: string[]
} {
  const raw = readRaw()
  if (isValidTheme(raw.theme)) cache.theme = raw.theme
  if (typeof raw.searchEngine === 'string' && raw.searchEngine in SEARCH_ENGINES) {
    cache.searchEngine = raw.searchEngine as SearchEngine
  }
  if (Array.isArray(raw.emergencyStopKeys)) {
    const keys = raw.emergencyStopKeys
      .filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 20)
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
  return {
    theme: cache.theme,
    session: cache.session,
    agentProviders: cache.agentProviders,
    activeProviderId: cache.activeProviderId,
    searchEngine: cache.searchEngine,
    emergencyStopKeys: cache.emergencyStopKeys
  }
}

/** The runtime config for the agent loop (active provider or first one). */
export function activeAgentConfig(): AgentConfig {
  const s = loadSettings()
  const p =
    s.agentProviders.find((x) => x.id === s.activeProviderId) ?? s.agentProviders[0] ?? null
  if (!p)
    return {
      baseUrl: '',
      apiKey: '',
      model: '',
      protocol: 'openai-chat',
      authType: 'key',
      providerName: ''
    }
  return {
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model,
    protocol: p.protocol,
    authType: p.authType,
    authSource: p.authSource,
    providerName: p.name
  }
}

export function saveTheme(theme: ThemeSetting): void {
  cache.theme = theme
  try {
    fs.mkdirSync(cobrowseDir(), { recursive: true })
    const next = { ...readRaw(), theme }
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* settings must never crash the app */
  }
}

export function saveSearchEngine(engine: SearchEngine): void {
  cache.searchEngine = engine
  try {
    fs.mkdirSync(cobrowseDir(), { recursive: true })
    const next = { ...readRaw(), searchEngine: engine }
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* settings must never crash the app */
  }
}

export function saveEmergencyStopKeys(keys: string[]): void {
  cache.emergencyStopKeys = keys
  try {
    fs.mkdirSync(cobrowseDir(), { recursive: true })
    const next = { ...readRaw(), emergencyStopKeys: keys }
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* settings must never crash the app */
  }
}

export function saveSession(session: SavedSession | null): void {
  cache.session = session
  try {
    fs.mkdirSync(cobrowseDir(), { recursive: true })
    const next = { ...readRaw(), session }
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* settings must never crash the app */
  }
}

export function saveProviders(providers: AgentProvider[], activeProviderId: string | null): void {
  cache.agentProviders = providers
  cache.activeProviderId = activeProviderId
  try {
    fs.mkdirSync(cobrowseDir(), { recursive: true })
    const next: Record<string, unknown> = {
      ...readRaw(),
      agentProviders: providers,
      activeProviderId
    }
    delete next.agent
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* settings must never crash the app */
  }
}
