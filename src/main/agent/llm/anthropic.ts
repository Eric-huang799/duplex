/**
 * Anthropic Messages API client (/v1/messages) with streaming and tool use.
 * Converts the internal OpenAI-style messages to Anthropic's content-block
 * format and maps stream events back.
 */
import { sseRequest } from './sse'
import { safeToolArgs } from './parse'
import { assertTrustedImportedEndpoint } from '../auth-import'
import type { ChatMessage, ChatStreamOptions, ChatStreamResult, ToolCall } from './types'

const DEFAULT_MAX_TOKENS = 8192
const MAX_TOKENS_SUFFIX = '…（输出已达 max_tokens 上限，可能被截断）'

function resolveMaxTokens(opts: ChatStreamOptions): number {
  const v = opts.maxTokens
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v)
  return DEFAULT_MAX_TOKENS
}

function messagesUrl(baseUrl: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('未配置 API 地址')
  if (/\/v1\/messages$/i.test(base)) return base
  return `${base}/v1/messages`
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: unknown
  /** internal marker: content is a list of tool_result blocks (for merging) */
  _toolResults?: boolean
}

export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string
  messages: AnthropicMessage[]
} {
  const systemParts: string[] = []
  const out: AnthropicMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content)
      continue
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content ?? '' })
      continue
    }
    if (m.role === 'assistant') {
      const blocks: unknown[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeToolArgs(tc.function.arguments)
        })
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks })
      continue
    }
    // tool result → part of a user message; merge consecutive results
    const block = {
      type: 'tool_result',
      tool_use_id: m.tool_call_id ?? '',
      content: m.content ?? ''
    }
    const last = out[out.length - 1]
    if (last && last.role === 'user' && last._toolResults && Array.isArray(last.content)) {
      ;(last.content as unknown[]).push(block)
    } else {
      out.push({ role: 'user', content: [block], _toolResults: true })
    }
  }
  return { system: systemParts.join('\n\n'), messages: out }
}

export async function anthropicChatStream(opts: ChatStreamOptions): Promise<ChatStreamResult> {
  assertTrustedImportedEndpoint({
    authType: opts.authType,
    authSource: opts.authSource,
    baseUrl: opts.baseUrl,
    allowCustomHost: opts.allowCustomHost
  })
  const { system, messages } = toAnthropicMessages(opts.messages)
  let text = ''
  let stopReason = ''
  let usageLogged = false
  const toolBlocks = new Map<number, { id: string; name: string; json: string }>()

  const logUsage = (usage: unknown): void => {
    if (usage && !usageLogged) {
      usageLogged = true
      console.error(`[llm] usage: ${JSON.stringify(usage)}`)
    }
  }

  await sseRequest(
    messagesUrl(opts.baseUrl),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: resolveMaxTokens(opts),
        stream: true,
        ...(system ? { system } : {}),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        ...(opts.tools && opts.tools.length > 0
          ? {
              tools: opts.tools.map((t) => ({
                name: t.function.name,
                description: t.function.description,
                input_schema: t.function.parameters
              }))
            }
          : {})
      })
    },
    {
      signal: opts.signal,
      idleTimeoutMs: opts.idleTimeoutMs,
      isCompletionEvent: (ev) => ev.type === 'message_stop',
      onJson: (ev) => {
        const type = ev.type as string | undefined
        if (type === 'message_start') {
          logUsage((ev.message as { usage?: unknown } | undefined)?.usage)
          return
        }
        if (type === 'message_delta') {
          const delta = ev.delta as { stop_reason?: unknown } | undefined
          if (typeof delta?.stop_reason === 'string' && delta.stop_reason) {
            stopReason = delta.stop_reason
          }
          logUsage(ev.usage)
          return
        }
        if (type === 'content_block_start') {
          const cb = ev.content_block as { type?: string; id?: string; name?: string } | undefined
          if (cb?.type === 'tool_use') {
            const idx = Number(ev.index ?? 0)
            toolBlocks.set(idx, { id: cb.id ?? '', name: cb.name ?? '', json: '' })
          }
          return
        }
        if (type === 'content_block_delta') {
          const delta = ev.delta as
            | { type?: string; text?: string; partial_json?: string }
            | undefined
          if (!delta) return
          if (delta.type === 'text_delta' && delta.text) {
            text += delta.text
            opts.onTextDelta?.(delta.text)
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            const idx = Number(ev.index ?? 0)
            const cur = toolBlocks.get(idx)
            if (cur) cur.json += delta.partial_json
          }
          return
        }
        if (type === 'error') {
          const err = ev.error as { message?: string } | undefined
          throw new Error(`模型接口错误: ${err?.message ?? JSON.stringify(ev).slice(0, 200)}`)
        }
      }
    }
  )

  if (stopReason === 'max_tokens') {
    text += MAX_TOKENS_SUFFIX
  }

  const toolCalls: ToolCall[] = [...toolBlocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, v]) => v.name)
    .map(([, v]) => ({
      id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function' as const,
      function: { name: v.name, arguments: v.json || '{}' }
    }))

  return { text, toolCalls }
}
