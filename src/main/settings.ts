/** Persistent app settings (~/.cobrowse/settings.json). */
import fs from 'node:fs'
import path from 'node:path'
import { cobrowseDir } from '../shared/endpoint'
import { normalizeProviderState, type AgentProvider } from './agent/providers'

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
}

const cache: {
  theme: ThemeSetting
  session: SavedSession | null
  agentProviders: AgentProvider[]
  activeProviderId: string | null
} = {
  theme: 'system',
  session: null,
  agentProviders: [],
  activeProviderId: null
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
} {
  const raw = readRaw()
  if (isValidTheme(raw.theme)) cache.theme = raw.theme
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
    activeProviderId: cache.activeProviderId
  }
}

/** The runtime config for the agent loop (active provider or first one). */
export function activeAgentConfig(): AgentConfig {
  const s = loadSettings()
  const p =
    s.agentProviders.find((x) => x.id === s.activeProviderId) ?? s.agentProviders[0] ?? null
  if (!p) return { baseUrl: '', apiKey: '', model: '' }
  return { baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model }
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
