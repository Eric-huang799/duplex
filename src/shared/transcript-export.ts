/**
 * 对话导出：把面板事件流渲染成一份可保存 / 分享的 Markdown。
 *
 * 纯函数，不读写文件、不依赖 Electron；落盘由 main 进程负责。
 * 导出前统一脱敏（文本、标题、工具参数递归处理），避免把密钥写进文件。
 */

export interface TranscriptEvent {
  kind: 'text' | 'tool' | 'session'
  role?: 'user' | 'assistant'
  partID?: string
  text?: string
  tool?: string
  status?: string
  args?: unknown
  result?: string
  at?: number
}

export interface TranscriptMeta {
  title: string
  startedAt?: number
  exportedAt: number
  appVersion: string
  model?: string
}

const REDACTED = '***'
const MAX_TITLE = 120
const MAX_TOOL_ARGS = 240
const MAX_TOOL_RESULT = 300

/**
 * 密钥键名：JSON 引号、= / : 赋值、纯文本都覆盖，值整段替换成 ***。
 *
 * 刻意**不含** authorization / cookie：它们的值允许空格（"Authorization: Basic xxx"、
 * "Cookie: a=b; c=d"），通用规则会在第一个空格处截断，反而漏掉真正的内容；
 * 这两种形态由下面两条专用正则整行处理。
 */
const SECRET_KEY_RE =
  /(^|[^\w-])(["']?)(api[_-]?key|x[_-]?api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|token|password|passwd|secret|密码|密钥|令牌)\2(\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&)}\]]+)/gi

/** URL 里的 user:pass@ 只保留协议和主机，账号密码整段打码。 */
const URL_CREDENTIAL_RE = /(\bhttps?:\/\/)[^\s/@:]+:[^\s/@]+@/gi

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/\-=]{3,}/gi
/**
 * `Authorization: Basic xxx` / `Authorization: Token xxx` 这类非 Bearer 值。
 *
 * 注意 lookahead 必须**自己吃掉空白**（`(?![ \t]*Bearer\b)`）：写成
 * `(\s*[:=]\s*)(?!Bearer)` 时，`\s*` 会回溯到零宽、于是 lookahead 看到的是空格
 * 而不是 "Bearer"，整行照样被吞掉——Bearer 前缀就丢了。
 */
const AUTHORIZATION_VALUE_RE =
  /\b(authorization\s*[:=][ \t]*)(?![ \t]*Bearer\b)[^\r\n]{3,}/gi
/** `Cookie: a=b; c=d` 整段打码；值里本来就有分号，不能用通用键名正则。 */
const COOKIE_VALUE_RE = /\b((?:set-)?cookie\s*[:=]\s*)[^\r\n]{3,}/gi

const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{3,}/g

/** 参数对象的键名命中这些词时，值整段替换（含嵌套对象），不依赖值本身的长相。 */
const SECRET_KEY_NAME_RE =
  /api[_-]?key|x[_-]?api[_-]?key|authorization|cookie|set[_-]?cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|token|password|passwd|secret|密码|密钥|令牌/i

/** 单行剪裁：多行结果压成一行，超长加省略号。 */
function clipInline(input: string, max: number): string {
  const text = input.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 脱敏所有可能出现在导出文本里的密钥形态。 */
function redactText(input: string): string {
  let text = input.replace(
    URL_CREDENTIAL_RE,
    (_match, scheme: string) => `${scheme}${REDACTED}@`
  )
  // 先处理整行形态的头，再走通用键名规则，避免被截断成半个值
  text = text.replace(AUTHORIZATION_VALUE_RE, (_match, head: string) => `${head}${REDACTED}`)
  text = text.replace(COOKIE_VALUE_RE, (_match, head: string) => `${head}${REDACTED}`)
  text = text.replace(BEARER_RE, `Bearer ${REDACTED}`)
  text = text.replace(
    SECRET_KEY_RE,
    (_match, prefix: string, quote: string, key: string, sep: string) =>
      `${prefix}${quote}${key}${quote}${sep}${REDACTED}`
  )
  return text.replace(SK_KEY_RE, REDACTED)
}

/** 递归脱敏工具参数；遇到循环引用返回占位文本，保证导出不抛错。 */
function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[循环引用]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY_NAME_RE.test(key) ? REDACTED : redactValue(item, seen)
  }
  return out
}

function stringifyValue(value: unknown): string {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

/** 参数的展示顺序：常见"主参数"优先，让工具行读起来像 search("关键词")。 */
const ARG_KEYS = [
  'query',
  'q',
  'text',
  'url',
  'target',
  'selector',
  'title',
  'name',
  'prompt',
  'expression'
]

function quoteArg(value: string): string {
  const clipped = value.length > MAX_TOOL_ARGS ? `${value.slice(0, MAX_TOOL_ARGS - 1)}…` : value
  return JSON.stringify(clipped)
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return ''
  const safe = redactValue(args, new WeakSet<object>())
  if (typeof safe === 'string') return quoteArg(safe)
  if (typeof safe === 'object') {
    if (Array.isArray(safe)) return clipInline(stringifyValue(safe), MAX_TOOL_ARGS)
    const record = safe as Record<string, unknown>
    for (const key of ARG_KEYS) {
      const value = record[key]
      if (typeof value === 'string') return quoteArg(value)
    }
    for (const value of Object.values(record)) {
      if (typeof value === 'string') return quoteArg(value)
    }
  }
  return clipInline(stringifyValue(safe), MAX_TOOL_ARGS)
}

function normalizeStatus(status: string | undefined): string {
  const raw = (status ?? '').trim().toLowerCase()
  if (!raw) return 'ok'
  if (raw === 'completed' || raw === 'complete' || raw === 'done' || raw === 'success' || raw === 'ok') {
    return 'ok'
  }
  if (raw === 'error' || raw === 'failed' || raw === 'failure') return 'error'
  return clipInline(redactText(status ?? ''), 40) || 'ok'
}

function toolResultText(result: string | undefined, status: string): string {
  if (typeof result !== 'string' || !result.trim()) return ''
  const text = clipInline(redactText(result), MAX_TOOL_RESULT)
  if (!text || text === 'ok' || text === status) return ''
  return text
}

function renderTextEvent(event: TranscriptEvent): string {
  const raw = typeof event.text === 'string' ? event.text : ''
  const text = redactText(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+|\n+$/g, '')
  if (!text.trim()) return ''
  if (event.role === 'user') {
    return text
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n')
  }
  return text
}

function renderToolEvent(event: TranscriptEvent): string {
  const tool = clipInline(redactText(event.tool ?? ''), 80) || 'tool'
  const args = summarizeArgs(event.args)
  const status = normalizeStatus(event.status)
  const lines = [`- 🔧 ${tool}(${args}) → ${status}`]
  const result = toolResultText(event.result, status)
  if (result) lines.push(`  > 结果：${result}`)
  return lines.join('\n')
}

function renderSessionEvent(event: TranscriptEvent): string {
  const status = clipInline(redactText(event.status ?? ''), 60)
  return status ? `- 🧭 会话状态：${status}` : ''
}

/** 时间统一成 UTC ISO 风格；非法值回退「未知」，保证导出永不抛错。 */
function formatTime(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '未知'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '未知'
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

/**
 * 把事件流渲染成完整 Markdown：标题 + 元信息 + `## 对话`。
 * 空事件也返回合法文档，调用方可以直接落盘。
 */
export function exportTranscriptMarkdown(events: TranscriptEvent[], meta: TranscriptMeta): string {
  const list = Array.isArray(events) ? events : []
  const title =
    clipInline(redactText(typeof meta.title === 'string' ? meta.title : ''), MAX_TITLE) || '对话导出'
  const appVersion = clipInline(redactText(meta.appVersion ?? ''), 60) || '未知'
  const model = meta.model ? clipInline(redactText(meta.model), 120) : ''

  const metaLines = [`> 应用版本：${appVersion}`, `> 导出时间：${formatTime(meta.exportedAt)}`]
  if (meta.startedAt != null) metaLines.push(`> 开始时间：${formatTime(meta.startedAt)}`)
  if (model) metaLines.push(`> 模型：${model}`)
  metaLines.push(`> 事件数：${list.length}`)

  const blocks: string[] = [`# ${title}`, metaLines.join('\n'), '## 对话']
  for (const event of list) {
    if (!event) continue
    let block = ''
    if (event.kind === 'text') block = renderTextEvent(event)
    else if (event.kind === 'tool') block = renderToolEvent(event)
    else if (event.kind === 'session') block = renderSessionEvent(event)
    if (block) blocks.push(block)
  }
  if (blocks.length === 3) blocks.push('_（本次没有可导出的事件）_')

  // 导出文件可能被渲染成 HTML：把开标签转义，正文里的代码示例也一起处理。
  const markdown = blocks.join('\n\n').replace(/<script/gi, '&lt;script')
  return `${markdown}\n`
}
