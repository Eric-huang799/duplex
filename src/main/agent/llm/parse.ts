/**
 * Tolerant tool-argument parsing for model output that is *almost* JSON
 * (weak local models often wrap it in code fences or add trailing commas).
 */

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

export function parseToolArguments(
  raw: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const text = (raw ?? '').trim()
  if (!text || text === '{}') return { ok: true, value: {} }
  const attempts: string[] = [text]
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) attempts.push(fence[1].trim())
  const braced = extractFirstObject(text)
  if (braced && braced !== text) attempts.push(braced)
  for (const candidate of attempts) {
    try {
      const v = JSON.parse(fixTrailingCommas(candidate)) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return { ok: true, value: v as Record<string, unknown> }
      }
    } catch {
      /* try next candidate */
    }
  }
  return { ok: false, error: `无法解析工具参数（不是合法 JSON）: ${text.slice(0, 120)}` }
}

/** Lenient parse for protocol conversion (never throws; {} on failure). */
export function safeToolArgs(raw: string): Record<string, unknown> {
  const parsed = parseToolArguments(raw)
  return parsed.ok ? parsed.value : {}
}
