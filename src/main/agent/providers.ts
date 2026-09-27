/**
 * Multi-provider management for the built-in agent mode
 * (CC-Switch-style: keep several API configs and switch between them).
 * Pure logic here so it is unit-testable.
 */

export interface AgentProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
}

export interface MaskedProvider {
  id: string
  name: string
  baseUrl: string
  model: string
  hasKey: boolean
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
    hasKey: p.apiKey.length > 0
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
        model: typeof o.model === 'string' ? o.model.trim() : ''
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
        model: typeof legacy.model === 'string' ? legacy.model.trim() : ''
      })
      active = providers[0].id
    }
  }

  if (active && !providers.some((p) => p.id === active)) active = null
  if (!active && providers.length > 0) active = providers[0].id
  return { providers, activeProviderId: active }
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
      model: models[0] ?? ''
    })
  }
  return out
}

/** Append imported providers, skipping ones already present (same baseUrl+model). */
export function mergeProviders(
  existing: AgentProvider[],
  imported: AgentProvider[]
): { providers: AgentProvider[]; added: number } {
  const keys = new Set(existing.map((p) => `${p.baseUrl}|${p.model}`))
  let added = 0
  const next = existing.slice()
  for (const p of imported) {
    const key = `${p.baseUrl}|${p.model}`
    if (keys.has(key)) continue
    keys.add(key)
    next.push(p)
    added++
  }
  return { providers: next, added }
}
