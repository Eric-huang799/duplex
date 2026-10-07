/**
 * Multi-provider management for the built-in agent mode
 * (CC-Switch-style: keep several API configs and switch between them).
 * Pure logic here so it is unit-testable.
 */
import { isLlmProtocol, type LlmProtocol } from '../../shared/llm'

export type AuthType = 'key' | 'import'
export type AuthSource = 'codex' | 'opencode'

export interface AgentProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  /** Wire protocol of the chat API (defaults to 'openai-chat'). */
  protocol: LlmProtocol
  /** 'key' = apiKey stored locally; 'import' = read from a local CLI login. */
  authType: AuthType
  authSource?: AuthSource
  /** Allow a non-standard/self-hosted host for this provider. */
  allowCustomHost?: boolean
  /** Per-provider streaming idle timeout in milliseconds. */
  idleTimeoutMs?: number
}

export interface MaskedProvider {
  id: string
  name: string
  baseUrl: string
  model: string
  hasKey: boolean
  protocol: LlmProtocol
  authType: AuthType
  authSource?: AuthSource
  allowCustomHost?: boolean
  idleTimeoutMs?: number
}

export function newProviderId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function deriveName(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.replace(/^api\./, '')
  } catch {
    return baseUrl || '未命名'
  }
}

export function maskProviders(list: AgentProvider[]): MaskedProvider[] {
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    hasKey: p.apiKey.length > 0,
    protocol: p.protocol,
    authType: p.authType,
    authSource: p.authSource,
    allowCustomHost: p.allowCustomHost,
    idleTimeoutMs: p.idleTimeoutMs
  }))
}

/**
 * Normalize stored settings into the provider-list shape, migrating the old
 * single-agent config into a first entry.
 */
export function normalizeProviderState(input: {
  providers?: unknown
  activeProviderId?: unknown
  legacyAgent?: unknown
}): { providers: AgentProvider[]; activeProviderId: string | null } {
  const providers: AgentProvider[] = []
  if (Array.isArray(input.providers)) {
    for (const p of input.providers) {
      if (!p || typeof p !== 'object') continue
      const o = p as Record<string, unknown>
      if (typeof o.baseUrl !== 'string' || o.baseUrl.trim().length === 0) continue
      providers.push({
        id: typeof o.id === 'string' && o.id ? o.id : newProviderId(),
        name:
          typeof o.name === 'string' && o.name.trim().length > 0
            ? o.name.trim()
            : deriveName(o.baseUrl),
        baseUrl: o.baseUrl.trim(),
        apiKey: typeof o.apiKey === 'string' ? o.apiKey : '',
        model: typeof o.model === 'string' ? o.model.trim() : '',
        protocol: isLlmProtocol(o.protocol) ? o.protocol : 'openai-chat',
        authType: o.authType === 'import' ? 'import' : 'key',
        authSource:
          o.authSource === 'codex' || o.authSource === 'opencode' ? o.authSource : undefined,
        allowCustomHost:
          typeof o.allowCustomHost === 'boolean' ? o.allowCustomHost : undefined,
        idleTimeoutMs:
          typeof o.idleTimeoutMs === 'number' &&
          Number.isFinite(o.idleTimeoutMs) &&
          o.idleTimeoutMs >= 0
            ? Math.floor(o.idleTimeoutMs)
            : undefined
      })
    }
  }

  let active =
    typeof input.activeProviderId === 'string' && input.activeProviderId
      ? input.activeProviderId
      : null

  if (providers.length === 0) {
    const legacy = input.legacyAgent as
      | { baseUrl?: unknown; apiKey?: unknown; model?: unknown }
      | undefined
    if (legacy && typeof legacy.baseUrl === 'string' && legacy.baseUrl.trim().length > 0) {
      providers.push({
        id: newProviderId(),
        name: '默认',
        baseUrl: legacy.baseUrl.trim(),
        apiKey: typeof legacy.apiKey === 'string' ? legacy.apiKey : '',
        model: typeof legacy.model === 'string' ? legacy.model.trim() : '',
        protocol: 'openai-chat',
        authType: 'key'
      })
      active = providers[0].id
    }
  }

  if (active && !providers.some((p) => p.id === active)) active = null
  if (!active && providers.length > 0) active = providers[0].id
  return { providers, activeProviderId: active }
}

/** Best-effort protocol mapping from an opencode provider's npm package. */
function protocolFromNpm(npm: string): LlmProtocol {
  const n = npm.toLowerCase()
  if (n.includes('anthropic')) return 'anthropic-messages'
  if (n.includes('google') || n.includes('gemini')) return 'gemini'
  return 'openai-chat'
}

/**
 * Pick a sensible default model when importing from opencode: prefer a common
 * chat model (contains "chat", not an embedding/vision/audio specialty), then
 * any model that is not such a specialty, then the first listed model.
 */
function pickDefaultModel(models: string[]): string {
  if (models.length === 0) return ''
  const specialty = /(embed|rerank|vision|image|audio|speech|tts|whisper)/
  const lower = (m: string): string => m.toLowerCase()
  const chat = models.find((m) => lower(m).includes('chat') && !specialty.test(lower(m)))
  if (chat) return chat
  const general = models.find((m) => !specialty.test(lower(m)))
  return general ?? models[0]
}

/** Extract every usable provider from an opencode config object (key optional — local services like Ollama need none). */
export function providersFromOpencode(config: unknown): AgentProvider[] {
  const out: AgentProvider[] = []
  const providers = (config as { provider?: Record<string, unknown> } | null)?.provider
  if (!providers || typeof providers !== 'object') return out
  for (const [name, raw] of Object.entries(providers)) {
    const prov = raw as {
      options?: { apiKey?: unknown; baseURL?: unknown }
      models?: Record<string, unknown>
    }
    const apiKey = typeof prov?.options?.apiKey === 'string' ? prov.options.apiKey : ''
    const baseUrl = typeof prov?.options?.baseURL === 'string' ? prov.options.baseURL : ''
    if (!baseUrl.trim()) continue
    const models = prov?.models && typeof prov.models === 'object' ? Object.keys(prov.models) : []
    out.push({
      id: newProviderId(),
      name: name,
      baseUrl: baseUrl.trim(),
      apiKey,
      model: pickDefaultModel(models),
      protocol: protocolFromNpm(
        typeof (raw as { npm?: unknown }).npm === 'string' ? (raw as { npm: string }).npm : ''
      ),
      authType: 'key'
    })
  }
  return out
}

/**
 * Credential fingerprint for dedupe: auth type/source + whether a key is set +
 * a hash of the key prefix. Configs that only differ by credential must not be
 * treated as duplicates, while the raw key never enters the dedupe key.
 */
function credentialFingerprint(p: Pick<AgentProvider, 'authType' | 'authSource' | 'apiKey'>): string {
  const auth = p.authType === 'import' ? `import:${p.authSource ?? ''}` : 'key'
  const prefix = p.apiKey.slice(0, 8)
  let hash = 5381
  for (let i = 0; i < prefix.length; i++) hash = ((hash << 5) + hash + prefix.charCodeAt(i)) >>> 0
  return `${auth}|${p.apiKey ? 'k' : 'n'}|${hash.toString(36)}`
}

/** Append imported providers, skipping ones already present (same baseUrl+model+credential). */
export function mergeProviders(
  existing: AgentProvider[],
  imported: AgentProvider[]
): { providers: AgentProvider[]; added: number } {
  const keys = new Set(existing.map((p) => `${p.baseUrl}|${p.model}|${credentialFingerprint(p)}`))
  let added = 0
  const next = existing.slice()
  for (const p of imported) {
    const key = `${p.baseUrl}|${p.model}|${credentialFingerprint(p)}`
    if (keys.has(key)) continue
    keys.add(key)
    next.push(p)
    added++
  }
  return { providers: next, added }
}
