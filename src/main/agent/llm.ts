/**
 * Minimal OpenAI-compatible chat client with streaming (SSE) and tool calls.
 * Works with DeepSeek / Qwen (compatible mode) / Kimi / Ollama / any
 * OpenAI-style API.
 *
 * Hardened for weaker (local) models:
 *  - tolerant parsing of tool-call arguments (code fences, trailing commas,
 *    embedded JSON)
 *  - an idle watchdog: a stream that produces no data for a long time is
 *    aborted instead of hanging the agent forever
 */

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface OpenAiToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatStreamOptions {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  tools?: OpenAiToolSchema[]
  signal?: AbortSignal
  onTextDelta?: (delta: string) => void
  /** Abort when no data arrives for this long (default 120s). */
  idleTimeoutMs?: number
}

export interface ChatStreamResult {
  text: string
  toolCalls: ToolCall[]
}

const DEFAULT_IDLE_TIMEOUT_MS = 120_000

function completionsUrl(baseUrl: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('未配置 API 地址')
  if (/\/chat\/completions$/i.test(base)) return base
  return `${base}/chat/completions`
}

function extractFirstObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

function fixTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, '$1')
}

/**
 * Tolerant tool-argument parsing for model output that is *almost* JSON
 * (weak local models often wrap it in code fences or add trailing commas).
 */
export function parseToolArguments(
  raw: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const text = (raw ?? '').trim()
  if (!text || text === '{}') return { ok: true, value: {} }
  const attempts: string[] = [text]
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) attempts.push(fence[1].trim())
  const braced = extractFirstObject(text)
  if (braced && braced !== text) attempts.push(braced)
  for (const candidate of attempts) {
    try {
      const v = JSON.parse(fixTrailingCommas(candidate)) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return { ok: true, value: v as Record<string, unknown> }
      }
    } catch {
      /* try next candidate */
    }
  }
  return { ok: false, error: `无法解析工具参数（不是合法 JSON）: ${text.slice(0, 120)}` }
}

export async function chatStream(opts: ChatStreamOptions): Promise<ChatStreamResult> {
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const ctl = new AbortController()
  let idleTimedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const bump = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      ctl.abort()
    }, idleMs)
  }
  const onOuterAbort = (): void => ctl.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
  bump()

  try {
    const res = await fetch(completionsUrl(opts.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // local services (Ollama etc.) need no key — omit the header entirely
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        stream: true
      }),
      signal: ctl.signal
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`模型接口返回 ${res.status}: ${body.slice(0, 300)}`)
    }
    if (!res.body) throw new Error('模型接口未返回流式响应')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let text = ''
    const toolAcc = new Map<number, { id: string; name: string; args: string }>()

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bump()
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let json: unknown
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        const delta = (
          json as {
            choices?: Array<{
              delta?: {
                content?: string | null
                tool_calls?: Array<{
                  index?: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
            }>
          }
        )?.choices?.[0]?.delta
        if (!delta) continue
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content
          opts.onTextDelta?.(delta.content)
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = Number(tc.index ?? 0)
            const cur = toolAcc.get(idx) ?? { id: '', name: '', args: '' }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name = tc.function.name
            if (tc.function?.arguments) cur.args += tc.function.arguments
            toolAcc.set(idx, cur)
          }
        }
      }
    }

    const toolCalls: ToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, v]) => v.name)
      .map(([, v]) => ({
        id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function' as const,
        function: { name: v.name, arguments: v.args || '{}' }
      }))

    return { text, toolCalls }
  } catch (e) {
    if (idleTimedOut) {
      throw new Error(`模型响应超时（${Math.round(idleMs / 1000)} 秒无数据），已中断`)
    }
    throw e
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}
