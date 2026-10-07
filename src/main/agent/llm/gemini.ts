/**
 * Google Gemini client (streamGenerateContent, alt=sse) with function calls.
 * Converts internal OpenAI-style messages to Gemini `contents` and maps
 * functionCall / text parts back.
 */
import { sseRequest } from './sse'
import { safeToolArgs } from './parse'
import { assertTrustedImportedEndpoint } from '../auth-import'
import type { ChatMessage, ChatStreamOptions, ChatStreamResult, ToolCall } from './types'

function streamUrl(baseUrl: string, model: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('未配置 API 地址')
  return `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
}

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}
interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export function toGeminiContents(messages: ChatMessage[]): {
  system: string
  contents: GeminiContent[]
} {
  // tool_call_id → function name lookup (functionResponse requires the name)
  const idToName = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const tc of m.tool_calls ?? []) idToName.set(tc.id, tc.function.name)
    }
  }

  const systemParts: string[] = []
  const contents: GeminiContent[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content)
      continue
    }
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content ?? '' }] })
      continue
    }
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = []
      if (m.content) parts.push({ text: m.content })
      for (const tc of m.tool_calls ?? []) {
        parts.push({ functionCall: { name: tc.function.name, args: safeToolArgs(tc.function.arguments) } })
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }
    // tool result → functionResponse inside a user turn; merge consecutive
    const part: GeminiPart = {
      functionResponse: {
        name: idToName.get(m.tool_call_id ?? '') ?? 'unknown',
        response: { output: m.content ?? '' }
      }
    }
    const last = contents[contents.length - 1]
    if (last && last.role === 'user' && last.parts.some((p) => p.functionResponse)) {
      last.parts.push(part)
    } else {
      contents.push({ role: 'user', parts: [part] })
    }
  }
  return { system: systemParts.join('\n\n'), contents }
}

export async function geminiChatStream(opts: ChatStreamOptions): Promise<ChatStreamResult> {
  assertTrustedImportedEndpoint({
    authType: opts.authType,
    authSource: opts.authSource,
    baseUrl: opts.baseUrl,
    allowCustomHost: opts.allowCustomHost
  })
  if (!opts.apiKey) throw new Error('未填写 API Key')
  const { system, contents } = toGeminiContents(opts.messages)
  let text = ''
  let usageLogged = false
  const toolCalls: ToolCall[] = []

  await sseRequest(
    streamUrl(opts.baseUrl, opts.model),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': opts.apiKey
      },
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        ...(opts.maxTokens && opts.maxTokens > 0
          ? { generationConfig: { maxOutputTokens: Math.floor(opts.maxTokens) } }
          : {}),
        ...(opts.tools && opts.tools.length > 0
          ? {
              tools: [
                {
                  functionDeclarations: opts.tools.map((t) => ({
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters
                  }))
                }
              ]
            }
          : {})
      })
    },
    {
      signal: opts.signal,
      idleTimeoutMs: opts.idleTimeoutMs,
      isCompletionEvent: (ev) => {
        const candidates = ev.candidates as Array<{ finishReason?: unknown }> | undefined
        return Array.isArray(candidates) && candidates.some((c) => c?.finishReason != null)
      },
      onJson: (ev) => {
        if (ev.usageMetadata && !usageLogged) {
          usageLogged = true
          console.error(`[llm] usage: ${JSON.stringify(ev.usageMetadata)}`)
        }
        const candidates = ev.candidates as
          | Array<{ content?: { parts?: GeminiPart[] } }>
          | undefined
        const parts = candidates?.[0]?.content?.parts
        if (!Array.isArray(parts)) return
        for (const p of parts) {
          if (typeof p.text === 'string' && p.text) {
            text += p.text
            opts.onTextDelta?.(p.text)
          } else if (p.functionCall && p.functionCall.name) {
            toolCalls.push({
              id: `call_${Math.random().toString(36).slice(2, 10)}`,
              type: 'function',
              function: {
                name: p.functionCall.name,
                arguments: JSON.stringify(p.functionCall.args ?? {})
              }
            })
          }
        }
      }
    }
  )

  return { text, toolCalls }
}
