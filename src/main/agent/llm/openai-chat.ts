/**
 * OpenAI-compatible chat client (/chat/completions) with streaming (SSE) and
 * tool calls. Works with DeepSeek / Qwen (compatible mode) / Kimi / Ollama /
 * any OpenAI-style API.
 */
import { sseRequest } from './sse'
import { assertTrustedImportedEndpoint } from '../auth-import'
import type { ChatStreamOptions, ChatStreamResult, LlmToolSchema, ToolCall } from './types'

/**
 * 本地推理端点（Ollama / LM Studio / llama.cpp …）。它们对工具调用协议的支持
 * 普遍更弱：不认识 `tool_choice`、并行调用会串位、上下文小到装不下长描述。
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const u = new URL((baseUrl || '').trim())
    const host = u.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0') return true
    if (u.port === '11434') return true // Ollama 默认端口
    return host.endsWith('.local')
  } catch {
    return false
  }
}

/**
 * 小上下文模型里，超长的英文工具描述会把真正有用的信息挤掉（甚至触发静默截断）。
 * 只保留首句，长度封顶——工具名和参数仍然完整，不影响调用正确性。
 */
export function compactToolDescriptions(tools: LlmToolSchema[], maxLen = 280): LlmToolSchema[] {
  return tools.map((tool) => {
    const description = tool.function.description ?? ''
    const firstSentence = description.split(/\n+|(?<=\.)\s/)[0]?.trim() ?? ''
    const shortened =
      firstSentence.length > maxLen ? `${firstSentence.slice(0, maxLen - 1)}…` : firstSentence
    return {
      ...tool,
      function: { ...tool.function, description: shortened || description }
    }
  })
}

function completionsUrl(baseUrl: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('未配置 API 地址')
  if (/\/chat\/completions$/i.test(base)) return base
  return `${base}/chat/completions`
}

/** Some gateways send content as an array of parts; join the text parts. */
function deltaText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join('')
  }
  return ''
}

export async function openaiChatStream(opts: ChatStreamOptions): Promise<ChatStreamResult> {
  assertTrustedImportedEndpoint({
    authType: opts.authType,
    authSource: opts.authSource,
    baseUrl: opts.baseUrl,
    allowCustomHost: opts.allowCustomHost
  })
  let text = ''
  let usageLogged = false
  let finishReason = ''
  const local = isLocalEndpoint(opts.baseUrl)
  const hasTools = !!opts.tools && opts.tools.length > 0
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()

  await sseRequest(
    completionsUrl(opts.baseUrl),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // local services (Ollama etc.) need no key — omit the header entirely
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        // 本地模型经常忽略 tool_choice，但不认识它时会报错；显式 auto 对兼容实现更友好
        ...(hasTools
          ? {
              tools: local ? compactToolDescriptions(opts.tools as LlmToolSchema[]) : opts.tools,
              tool_choice: 'auto',
              // 并行调用在小模型上容易串位/丢参数，逐个来更稳
              parallel_tool_calls: false
            }
          : {}),
        // 本地小模型在高温下几乎不会稳定吐出结构化工具调用
        ...(hasTools && local ? { temperature: 0 } : {}),
        stream: true
      })
    },
    {
      signal: opts.signal,
      idleTimeoutMs: opts.idleTimeoutMs,
      isCompletionEvent: (json) => {
        const choices = (json as { choices?: Array<{ finish_reason?: unknown }> }).choices
        const reason = choices?.find((c) => c?.finish_reason != null)?.finish_reason
        if (typeof reason === 'string') finishReason = reason
        return Array.isArray(choices) && choices.some((c) => c?.finish_reason != null)
      },
      onJson: (json) => {
        const usage = (json as { usage?: unknown }).usage
        if (usage && !usageLogged) {
          usageLogged = true
          console.error(`[llm] usage: ${JSON.stringify(usage)}`)
        }
        const delta = (
          json as {
            choices?: Array<{
              delta?: {
                content?: unknown
                tool_calls?: Array<{
                  index?: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
            }>
          }
        )?.choices?.[0]?.delta
        if (!delta) return
        const chunk = deltaText(delta.content)
        if (chunk) {
          text += chunk
          opts.onTextDelta?.(chunk)
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
  )

  if (finishReason === 'length') {
    // 本地模型最隐蔽的一种失败：上下文不够，工具定义被静默截断，于是"模型好像不会用工具"
    console.error(
      '[llm] 输出被截断（finish_reason=length）。本地模型常见原因：上下文窗口不足，工具定义可能没有被完整加载。建议换更大的模型或调高 num_ctx。'
    )
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
}
