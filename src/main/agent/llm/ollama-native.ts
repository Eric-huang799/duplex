/**
 * Ollama 原生协议适配器（`/api/chat`，NDJSON 流）。
 *
 * 为什么不继续用 OpenAI 兼容层：兼容层做不到两件关键的事——
 *
 *  1. **不能设 `num_ctx`**。本地小模型默认上下文常常只有 2k–4k，系统提示 + 25 个
 *     工具定义一塞就超了，模型根本没"看见"工具，表现就是"完全不会用工具"。
 *     原生接口可以用 `options.num_ctx` 明确指定。
 *  2. **问不出模型能力**。`/api/show` 会返回 `capabilities`，其中是否含 `tools`
 *     直接决定这个模型能不能用函数调用。有了它就能把"玄学"变成一句明确的提示。
 *
 * 原生接口的工具调用与 OpenAI 的差异：
 *  - 流是 NDJSON（每行一个 JSON），不是 SSE；
 *  - `tool_calls[].function.arguments` 是**对象**而不是 JSON 字符串；
 *  - 历史里的 assistant 工具调用也要用对象形式回传，否则会被拒。
 */
import type { ChatMessage, ChatStreamOptions, ChatStreamResult, LlmToolSchema, ToolCall } from './types'

/** 工具定义数量多时本地模型的挑错率上升；这里给描述做个上限，保住参数结构。 */
const MAX_TOOL_DESCRIPTION = 280

export function ollamaRoot(baseUrl: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '')
  if (/\/api$/i.test(base)) return base
  return base.replace(/\/v1$/i, '')
}

/**
 * 判断是否 Ollama。判据刻意保守——**误判会直接把请求打到不存在的 `/api/chat`**：
 *  - 默认端口 `11434`（换端口的用户可用 `http://host:11434` 或显式 /api 路径）；
 *  - 或路径明确是 `/api`（Ollama 家族特有的根路径）。
 * LM Studio / llama.cpp 等虽同为本地服务，但没有 `/api/chat`，绝不能抢。
 */
export function isOllamaEndpoint(baseUrl: string): boolean {
  try {
    const u = new URL((baseUrl || '').trim())
    if (u.port === '11434') return true
    return u.pathname.replace(/\/+$/, '') === '/api'
  } catch {
    return false
  }
}

function compact(tools: LlmToolSchema[]): LlmToolSchema[] {
  return tools.map((tool) => {
    const description = tool.function.description ?? ''
    const first = description.split(/\n+|(?<=\.)\s/)[0]?.trim() ?? ''
    const shortened = first.length > MAX_TOOL_DESCRIPTION ? `${first.slice(0, MAX_TOOL_DESCRIPTION - 1)}…` : first
    return { ...tool, function: { ...tool.function, description: shortened || description } }
  })
}

/** 把内部消息转换成 Ollama 原生格式（arguments 必须是对象）。 */
export function toOllamaMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: 'assistant',
        content: m.content ?? '',
        tool_calls: m.tool_calls.map((call) => ({
          function: {
            name: call.function.name,
            arguments: safeArguments(call.function.arguments)
          }
        }))
      }
    }
    if (m.role === 'tool') {
      // 原生格式不要求 tool_call_id，但要保留内容
      return { role: 'tool', content: m.content ?? '' }
    }
    return { role: m.role, content: m.content ?? '' }
  })
}

function safeArguments(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/** `num_ctx` 默认 8192：够放系统提示 + 工具定义 + 一段对话；可用环境变量覆盖。 */
export function resolveNumCtx(): number {
  const raw = Number(process.env['DUPLEX_OLLAMA_NUM_CTX'])
  if (Number.isFinite(raw) && raw >= 2048) return Math.floor(raw)
  return 8192
}

export function buildOllamaBody(
  opts: Pick<ChatStreamOptions, 'model' | 'messages' | 'tools'>,
  numCtx = resolveNumCtx()
): Record<string, unknown> {
  const tools = opts.tools ?? []
  return {
    model: opts.model,
    messages: toOllamaMessages(opts.messages),
    stream: true,
    ...(tools.length > 0 ? { tools: compact(tools) } : {}),
    options: {
      num_ctx: numCtx,
      // 本地小模型在高温下几乎不会稳定吐出结构化调用
      temperature: 0
    }
  }
}

export interface OllamaChunk {
  text: string
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
  done: boolean
  doneReason?: string
}

/** 解析一行 NDJSON。无法解析时返回 null（调用方跳过即可）。 */
export function parseOllamaChunk(line: string): OllamaChunk | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let json: Record<string, unknown>
  try {
    json = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }
  if (json.error) throw new Error(String(json.error))
  const message = json.message as
    | {
        content?: unknown
        tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }>
      }
    | undefined
  const text = typeof message?.content === 'string' ? message.content : ''
  const toolCalls: OllamaChunk['toolCalls'] = []
  for (const raw of message?.tool_calls ?? []) {
    const name = typeof raw?.function?.name === 'string' ? raw.function.name : ''
    if (!name) continue
    const args = raw?.function?.arguments
    toolCalls.push({
      name,
      arguments:
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : safeArguments(typeof args === 'string' ? args : '')
    })
  }
  return {
    text,
    toolCalls,
    done: json.done === true,
    ...(typeof json.done_reason === 'string' ? { doneReason: json.done_reason } : {})
  }
}

/** 查询模型能力：是否支持 tools、上下文长度。失败返回 null（不影响主流程）。 */
export async function probeOllamaModel(
  baseUrl: string,
  model: string,
  timeoutMs = 4000
): Promise<{ tools: boolean; contextLength: number | null } | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetch(`${ollamaRoot(baseUrl)}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: controller.signal
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      capabilities?: unknown
      model_info?: Record<string, unknown>
    }
    const caps = Array.isArray(json.capabilities) ? json.capabilities.map(String) : []
    let contextLength: number | null = null
    for (const [key, value] of Object.entries(json.model_info ?? {})) {
      if (key.endsWith('.context_length') && typeof value === 'number' && Number.isFinite(value)) {
        contextLength = value
        break
      }
    }
    return { tools: caps.includes('tools'), contextLength }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 读 NDJSON 流：按行切分，逐行回调。 */
async function readNdjson(
  response: Response,
  onChunk: (chunk: OllamaChunk) => void,
  idleTimeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  const body = response.body as ReadableStream<Uint8Array> | null
  if (!body) throw new Error('服务端没有返回内容流')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let idle = 0
  const bumpIdle = (): void => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => controller.abort(), idleTimeoutMs) as unknown as number
    ;(idle as unknown as { unref?: () => void }).unref?.()
  }
  const controller = new AbortController()
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })
  bumpIdle()
  try {
    for (;;) {
      if (controller.signal.aborted) throw new Error('任务已取消或模型超时未响应')
      const { value, done } = await reader.read()
      if (done) break
      bumpIdle()
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        const chunk = parseOllamaChunk(line)
        if (chunk) onChunk(chunk)
        idx = buffer.indexOf('\n')
      }
    }
    const tail = parseOllamaChunk(buffer)
    if (tail) onChunk(tail)
  } finally {
    if (idle) clearTimeout(idle)
    try {
      await reader.cancel()
    } catch {
      /* stream already closed */
    }
  }
}

const capabilityCache = new Map<string, { tools: boolean; contextLength: number | null } | null>()

/**
 * 一次性告知"这个模型到底能不能调工具"。很多本地模型（尤其去审查微调）压根没有
 * 工具能力，此时再怎么调参数都没用——写清楚比让用户猜有价值。
 */
async function warnUnlessToolCapable(baseUrl: string, model: string): Promise<void> {
  const key = `${ollamaRoot(baseUrl)}|${model}`
  if (!capabilityCache.has(key)) {
    capabilityCache.set(key, await probeOllamaModel(baseUrl, model))
  }
  const info = capabilityCache.get(key)
  if (!info) return
  if (!info.tools) {
    console.error(
      `[llm] 模型 ${model} 的 capabilities 里没有 tools：它不支持函数调用，换模型才能解决（不是参数问题）。`
    )
  }
  const numCtx = resolveNumCtx()
  if (info.contextLength && info.contextLength < numCtx) {
    console.error(
      `[llm] 模型 ${model} 的上下文长度只有 ${info.contextLength}，低于 num_ctx=${numCtx}：提示与工具定义可能被截断。可用 DUPLEX_OLLAMA_NUM_CTX 下调。`
    )
  }
}

export async function ollamaNativeStream(opts: ChatStreamOptions): Promise<ChatStreamResult> {
  let text = ''
  let doneReason = ''
  const toolCalls: ToolCall[] = []
  if (opts.tools && opts.tools.length > 0) void warnUnlessToolCapable(opts.baseUrl, opts.model)
  const controller = new AbortController()
  if (opts.signal) {
    if (opts.signal.aborted) throw new Error('任务已取消')
    opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const res = await fetch(`${ollamaRoot(opts.baseUrl)}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {})
    },
    body: JSON.stringify(buildOllamaBody(opts)),
    signal: controller.signal
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 300)
    } catch {
      /* body may be gone */
    }
    throw new Error(`Ollama 返回 ${res.status} ${res.statusText}${detail ? `：${detail}` : ''}`)
  }

  await readNdjson(
    res,
    (chunk) => {
      if (chunk.text) {
        text += chunk.text
        opts.onTextDelta?.(chunk.text)
      }
      for (const call of chunk.toolCalls) {
        toolCalls.push({
          id: `call_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        })
      }
      if (chunk.doneReason) doneReason = chunk.doneReason
    },
    opts.idleTimeoutMs ?? 120_000,
    opts.signal
  )

  if (doneReason === 'length') {
    console.error(
      '[llm] Ollama 输出被截断（done_reason=length）：上下文不足，工具定义可能没被完整加载。可用 DUPLEX_OLLAMA_NUM_CTX 调高 num_ctx。'
    )
  }

  return { text, toolCalls }
}
