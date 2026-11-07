/**
 * LLM client factory: one entry point (`chatStream`) dispatching to the
 * adapter selected by the provider's protocol.
 */
import { openaiChatStream } from './openai-chat'
import { anthropicChatStream } from './anthropic'
import { responsesChatStream } from './openai-responses'
import { geminiChatStream } from './gemini'
import { repairToolCallsFromText } from './tool-repair'
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
  return withRepairedToolCalls(await dispatch(opts), opts)
}

async function dispatch(opts: ChatStreamOptions): Promise<ChatStreamResult> {
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

/**
 * 兜底：模型把工具调用写成正文（JSON / 代码块 / XML / `name({...})`）时把它救回来。
 * 只对"给了工具但一个原生调用都没有"的回答生效；工具名必须在名单里，避免误判。
 */
function withRepairedToolCalls(result: ChatStreamResult, opts: ChatStreamOptions): ChatStreamResult {
  const tools = opts.tools ?? []
  if (tools.length === 0 || result.toolCalls.length > 0) return result
  const repaired = repairToolCallsFromText(
    result.text,
    tools.map((tool) => tool.function.name)
  )
  if (repaired.toolCalls.length === 0) return result
  console.error(
    `[llm] 模型没有返回原生 tool_calls，已从正文恢复 ${repaired.toolCalls.length} 个调用：` +
      repaired.toolCalls.map((call) => call.function.name).join(', ')
  )
  return { text: repaired.text, toolCalls: repaired.toolCalls }
}
