/**
 * Shared types for the built-in agent's LLM clients. The internal message
 * format is OpenAI-style (ChatMessage); every adapter converts it to its own
 * wire format and converts streaming events back.
 */
import type { LlmProtocol } from '../../../shared/llm'
import type { AuthSource, AuthType } from '../providers'

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

export interface LlmToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatStreamOptions {
  /** Wire protocol; defaults to 'openai-chat'. */
  protocol?: LlmProtocol
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  tools?: LlmToolSchema[]
  signal?: AbortSignal
  onTextDelta?: (delta: string) => void
  /** Abort when no data arrives for this long (default 120s). */
  idleTimeoutMs?: number
  /** Provider auth mode; 'import' triggers the official-endpoint safety check. */
  authType?: AuthType
  /** Where the imported credential came from (codex / opencode). */
  authSource?: AuthSource
  /** User explicitly trusts a custom gateway for imported OAuth credentials. */
  allowCustomHost?: boolean
  /** Optional response token cap; adapters apply it where the protocol supports it. */
  maxTokens?: number
}

export interface ChatStreamResult {
  text: string
  toolCalls: ToolCall[]
}

export function genToolCallId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}`
}
