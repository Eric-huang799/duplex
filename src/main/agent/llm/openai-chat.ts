/**
 * OpenAI-compatible chat client (/chat/completions) with streaming (SSE) and
 * tool calls. Works with DeepSeek / Qwen (compatible mode) / Kimi / Ollama /
 * any OpenAI-style API.
 */
import { sseRequest } from './sse'
import type { ChatStreamOptions, ChatStreamResult, ToolCall } from './types'

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
  let text = ''
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
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        stream: true
      })
    },
    {
      signal: opts.signal,
      idleTimeoutMs: opts.idleTimeoutMs,
      onJson: (json) => {
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
