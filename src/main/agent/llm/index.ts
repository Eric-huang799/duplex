/**
 * LLM client factory: one entry point (`chatStream`) dispatching to the
 * adapter selected by the provider's protocol.
 */
import { openaiChatStream } from './openai-chat'
import { anthropicChatStream } from './anthropic'
import { responsesChatStream } from './openai-responses'
import { geminiChatStream } from './gemini'
import type { ChatStreamOptions, ChatStreamResult } from './types'

export type {
  ChatMessage,
  ChatStreamOptions,
  ChatStreamResult,
  LlmToolSchema,
  ToolCall
} from './types'
export { parseToolArguments, safeToolArgs } from './parse'
export { DEFAULT_IDLE_TIMEOUT_MS } from './sse'

export async function chatStream(opts: ChatStreamOptions): Promise<ChatStreamResult> {
  switch (opts.protocol ?? 'openai-chat') {
    case 'anthropic-messages':
      return anthropicChatStream(opts)
    case 'openai-responses':
      return responsesChatStream(opts)
    case 'gemini':
      return geminiChatStream(opts)
    default:
      return openaiChatStream(opts)
  }
}
