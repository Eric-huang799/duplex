/**
 * LLM protocol identifiers shared by the main process (adapters) and the
 * renderer (provider editor UI).
 */

export type LlmProtocol = 'openai-chat' | 'anthropic-messages' | 'openai-responses' | 'gemini'

export const LLM_PROTOCOLS: LlmProtocol[] = [
  'openai-chat',
  'anthropic-messages',
  'openai-responses',
  'gemini'
]

export const PROTOCOL_LABELS: Record<LlmProtocol, string> = {
  'openai-chat': 'OpenAI 兼容 (/chat/completions)',
  'anthropic-messages': 'Anthropic (/v1/messages)',
  'openai-responses': 'OpenAI Responses (/v1/responses)',
  gemini: 'Google Gemini (generateContent)'
}

export function isLlmProtocol(v: unknown): v is LlmProtocol {
  return typeof v === 'string' && (LLM_PROTOCOLS as string[]).includes(v)
}
