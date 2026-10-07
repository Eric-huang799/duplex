/**
 * Tolerant tool-argument parsing for model output that is *almost* JSON
 * (weak local models often wrap it in code fences or add trailing commas).
 */

/** Why tool arguments could not be parsed (used for user-facing diagnosis). */
export type ToolArgsParseFailure = 'truncated' | 'type-mismatch' | 'not-json'

export type ToolArgsParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string; reason: ToolArgsParseFailure }

function extractFirstObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

function fixTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, '$1')
}

/** True when the text opens a JSON object but never closes it (truncated output). */
function looksTruncated(s: string): boolean {
  const start = s.indexOf('{')
  if (start < 0) return false
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') depth--
  }
  return depth > 0 || inStr
}

export function parseToolArguments(raw: string): ToolArgsParseResult {
  const text = (raw ?? '').trim()
  if (!text || text === '{}') return { ok: true, value: {} }
  const attempts: string[] = [text]
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) attempts.push(fence[1].trim())
  const braced = extractFirstObject(text)
  if (braced && braced !== text) attempts.push(braced)
  let sawNonObject = false
  let sawTruncated = false
  for (const candidate of attempts) {
    try {
      const v = JSON.parse(fixTrailingCommas(candidate)) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return { ok: true, value: v as Record<string, unknown> }
      }
      sawNonObject = true
    } catch (e) {
      if (
        looksTruncated(candidate) ||
        /unexpected end|unterminated/i.test(String((e as Error)?.message ?? ''))
      ) {
        sawTruncated = true
      }
    }
  }
  const reason: ToolArgsParseFailure = sawNonObject
    ? 'type-mismatch'
    : sawTruncated
      ? 'truncated'
      : 'not-json'
  const label =
    reason === 'truncated'
      ? '无法解析工具参数（响应可能被截断，JSON 不完整）'
      : reason === 'type-mismatch'
        ? '无法解析工具参数（必须是 JSON 对象，实际是其他 JSON 类型）'
        : '无法解析工具参数（不是合法 JSON）'
  return { ok: false, error: `${label}: ${text.slice(0, 120)}`, reason }
}

/** Lenient parse for protocol conversion (never throws; {} on failure). */
export function safeToolArgs(raw: string): Record<string, unknown> {
  const parsed = parseToolArguments(raw)
  return parsed.ok ? parsed.value : {}
}
