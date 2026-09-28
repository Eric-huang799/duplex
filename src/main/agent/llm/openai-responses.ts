/**
 * OpenAI Responses API client (/v1/responses) with streaming and function
 * calls. Also the protocol used by ChatGPT-subscription (Codex) credentials.
 */
import { sseRequest } from './sse'
import type { ChatMessage, ChatStreamOptions, ChatStreamResult, ToolCall } from './types'

function responsesUrl(baseUrl: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('未配置 API 地址')
  if (/\/v1\/responses$/i.test(base)) return base
  return `${base}/v1/responses`
}

export function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) input.push({ role: 'system', content: m.content })
      continue
    }
    if (m.role === 'user') {
      input.push({ role: 'user', content: m.content ?? '' })
      continue
    }
    if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content })
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments
        })
      }
      continue
    }
    // tool result
    input.push({
      type: 'function_call_output',
      call_id: m.tool_call_id ?? '',
      output: m.content ?? ''
    })
  }
  return input
}

export async function responsesChatStream(opts: ChatStreamOptions): Promise<ChatStreamResult> {
  let text = ''
  const pending = new Map<string, { callId: string; name: string; args: string }>()
  const order: string[] = []

  await sseRequest(
    responsesUrl(opts.baseUrl),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: opts.model,
        input: toResponsesInput(opts.messages),
        stream: true,
        ...(opts.tools && opts.tools.length > 0
          ? {
              tools: opts.tools.map((t) => ({
                type: 'function',
                name: t.function.name,
                description: t.function.description,
                parameters: t.function.parameters
              }))
            }
          : {})
      })
    },
    {
      signal: opts.signal,
      idleTimeoutMs: opts.idleTimeoutMs,
      onJson: (ev) => {
        const type = ev.type as string | undefined
        if (type === 'response.output_text.delta') {
          const d = typeof ev.delta === 'string' ? ev.delta : ''
          if (d) {
            text += d
            opts.onTextDelta?.(d)
          }
          return
        }
        if (type === 'response.output_item.added') {
          const item = ev.item as { type?: string; id?: string; call_id?: string; name?: string } | undefined
          if (item?.type === 'function_call' && item.id) {
            pending.set(item.id, { callId: item.call_id ?? '', name: item.name ?? '', args: '' })
            order.push(item.id)
          }
          return
        }
        if (type === 'response.function_call_arguments.delta') {
          const itemId = typeof ev.item_id === 'string' ? ev.item_id : ''
          const cur = pending.get(itemId)
          if (cur && typeof ev.delta === 'string') cur.args += ev.delta
          return
        }
        if (type === 'response.failed') {
          const resp = ev.response as { error?: { message?: string } } | undefined
          throw new Error(`模型接口错误: ${resp?.error?.message ?? 'response failed'}`)
        }
        if (type === 'error') {
          const err = ev as { message?: string; code?: string }
          throw new Error(`模型接口错误: ${err.message ?? err.code ?? 'unknown error'}`)
        }
      }
    }
  )

  const toolCalls: ToolCall[] = order
    .map((id) => pending.get(id))
    .filter((v): v is { callId: string; name: string; args: string } => !!v && !!v.name)
    .map((v) => ({
      id: v.callId || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function' as const,
      function: { name: v.name, arguments: v.args || '{}' }
    }))

  return { text, toolCalls }
}
