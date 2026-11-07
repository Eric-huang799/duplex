/**
 * 本地模型的工具调用修复层。
 *
 * 小模型 / 去审查微调（abliterated）常常**不按原生 `tool_calls` 回工具调用**，
 * 而是把调用写成正文里的 JSON、代码块或 XML：
 *
 *   {"name": "click", "arguments": {"ref": "e12"}}
 *   ```json
 *   {"tool": "navigate", "args": {"url": "https://…"}}
 *   ```
 *   <tool_call>{"name":"snapshot","arguments":{}}</tool_call>
 *
 * 这会表现为"模型完全不调工具"——运行期拿到零 `tool_calls`，就当成了一句普通回答。
 * 这一层把上面这些形式识别成真正的调用，并把那段文字从回答里摘掉。
 *
 * 安全边界：**只接受出现在 `known` 名单里的工具名**。宁可漏认，也不能把正文里
 * 恰好长得像 JSON 的内容当成动作去执行（那等于凭空多点一次按钮）。
 */
import type { ToolCall } from './types'

export interface RepairResult {
  toolCalls: ToolCall[]
  /** 摘掉已识别调用后的正文（识别不到时原样返回）。 */
  text: string
}

const MAX_REPAIRED_CALLS = 4

interface RawCall {
  name: string
  args: Record<string, unknown>
  /** 在原文里的起止位置，用于从正文中摘除。 */
  start: number
  end: number
}

function asArgs(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return {}
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * 从一个 JSON 值里读出工具调用。兼容几种常见形态：
 * 单个对象、对象数组、OpenAI 风格 `{function:{name,arguments}}`。
 */
function callsFromJson(value: unknown, known: Set<string>): Array<{ name: string; args: Record<string, unknown> }> {
  const out: Array<{ name: string; args: Record<string, unknown> }> = []
  const items = Array.isArray(value) ? value : [value]
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const fn = o.function && typeof o.function === 'object' ? (o.function as Record<string, unknown>) : null
    const rawName = fn?.name ?? o.name ?? o.tool ?? o.tool_name ?? o.action
    if (typeof rawName !== 'string') continue
    const name = rawName.trim()
    if (!known.has(name)) continue
    const args = asArgs(fn?.arguments ?? o.arguments ?? o.parameters ?? o.args ?? o.input ?? {})
    if (!args) continue
    out.push({ name, args })
    if (out.length >= MAX_REPAIRED_CALLS) break
  }
  return out
}

/** 找出所有"看起来是 JSON 对象"的片段（按大括号配平，跳过字符串内的括号）。 */
function jsonSpans(text: string): Array<{ start: number; end: number; raw: string }> {
  const spans: Array<{ start: number; end: number; raw: string }> = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          spans.push({ start: i, end: j + 1, raw: text.slice(i, j + 1) })
          i = j
          break
        }
      }
    }
  }
  return spans
}

/** `click({"ref":"e1"})` / `snapshot()` 这种"函数调用写法"。 */
function callsFromCallsStyle(text: string, known: Set<string>): Array<{ name: string; args: Record<string, unknown>; start: number; end: number }> {
  const out: Array<{ name: string; args: Record<string, unknown>; start: number; end: number }> = []
  const re = /([A-Za-z_][A-Za-z0-9_]{1,40})\s*\(\s*(\{[\s\S]*?\})?\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const name = m[1]
    if (!known.has(name)) continue
    const args = m[2] ? asArgs(m[2]) : {}
    if (!args) continue
    out.push({ name, args, start: m.index, end: m.index + m[0].length })
    if (out.length >= MAX_REPAIRED_CALLS) break
  }
  return out
}

export function repairToolCallsFromText(rawText: string, toolNames: readonly string[]): RepairResult {
  const text = rawText ?? ''
  const known = new Set(toolNames)
  if (!text.trim() || known.size === 0) return { toolCalls: [], text }

  const found: RawCall[] = []

  // 1) <tool_call>…</tool_call> / <tool>…</tool>
  const xmlRe = /<(tool_call|tool_use|tool)>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = xmlRe.exec(text)) !== null) {
    const inner = m[2].trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(inner)
    } catch {
      continue
    }
    for (const call of callsFromJson(parsed, known)) {
      found.push({ ...call, start: m.index, end: m.index + m[0].length })
    }
  }

  // 2) 任意位置的 JSON 片段（含 ```json 代码块，块内的对象也会被扫到）
  if (found.length === 0) {
    for (const span of jsonSpans(text)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(span.raw)
      } catch {
        continue
      }
      const calls = callsFromJson(parsed, known)
      if (calls.length === 0) continue
      for (const call of calls) found.push({ ...call, start: span.start, end: span.end })
      if (found.length >= MAX_REPAIRED_CALLS) break
    }
  }

  // 3) 函数调用写法
  if (found.length === 0) {
    for (const call of callsFromCallsStyle(text, known)) found.push(call)
  }

  if (found.length === 0) return { toolCalls: [], text }

  // 从正文里摘掉已识别的片段（保留其余说明文字），并把 ```json 空壳一并清掉
  let cleaned = text
  const ordered = [...found].sort((a, b) => b.start - a.start)
  for (const call of ordered) {
    cleaned = cleaned.slice(0, call.start) + cleaned.slice(call.end)
  }
  cleaned = cleaned.replace(/```(?:json|javascript|js)?\s*```/gi, '').replace(/\n{3,}/g, '\n\n').trim()

  const toolCalls: ToolCall[] = found.slice(0, MAX_REPAIRED_CALLS).map((call, i) => ({
    id: `call_repaired_${Date.now().toString(36)}_${i}`,
    type: 'function' as const,
    function: { name: call.name, arguments: JSON.stringify(call.args) }
  }))

  return { toolCalls, text: cleaned }
}
