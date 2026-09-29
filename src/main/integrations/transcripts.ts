/**
 * Transcript readers for external CLI agents. Each reader parses a tool's
 * local session files into a common (role, text, ts) message list, so the
 * side panel can mirror their conversations the way opencode's are mirrored.
 *
 * - Codex:      ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * - Claude Code: ~/.claude/projects/<project>/<sessionId>.jsonl
 * - custom:     any directory of .jsonl files (best-effort generic parsing)
 */
import fs from 'node:fs'
import path from 'node:path'

export interface TranscriptSession {
  id: string
  title: string
  updatedAt: number
  file: string
}

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  ts: number
}

const MAX_MESSAGES = 2000
const MAX_SESSIONS = 100
const HEAD_BYTES = 131072

function readHead(file: string, bytes = HEAD_BYTES): string {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const n = fs.readSync(fd, buf, 0, bytes, 0)
      return buf.subarray(0, n).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

function walkJsonl(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 5) return out
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    try {
      if (e.isDirectory()) walkJsonl(full, depth + 1, out)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
    } catch {
      /* skip unreadable entry */
    }
  }
  return out
}

function readJsonlMessages(
  file: string,
  mapper: (o: unknown) => TranscriptMessage[]
): TranscriptMessage[] {
  let content: string
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: TranscriptMessage[] = []
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(...mapper(JSON.parse(t)))
    } catch {
      /* skip malformed line */
    }
  }
  return out.slice(-MAX_MESSAGES)
}

function buildSessions(
  files: string[],
  mapper: (o: unknown) => TranscriptMessage[],
  keep: (file: string) => boolean
): TranscriptSession[] {
  const entries: Array<{ file: string; mtime: number }> = []
  for (const f of files) {
    if (!keep(f)) continue
    try {
      entries.push({ file: f, mtime: fs.statSync(f).mtimeMs })
    } catch {
      /* skip */
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  const out: TranscriptSession[] = []
  for (const { file, mtime } of entries.slice(0, MAX_SESSIONS)) {
    let title = ''
    for (const line of readHead(file).split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const msgs = mapper(JSON.parse(t))
        const firstUser = msgs.find((m) => m.role === 'user')
        if (firstUser) {
          title = firstUser.text.replace(/\s+/g, ' ').slice(0, 60)
          break
        }
      } catch {
        /* skip */
      }
    }
    out.push({
      id: path.basename(file, '.jsonl'),
      title: title || '（无标题）',
      updatedAt: mtime,
      file
    })
  }
  return out
}

// ---------------------------------------------------------------- Codex

interface CodexLine {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    role?: string
    content?: Array<{ type?: string; text?: string }>
  }
}

export function codexLineMessages(o: unknown): TranscriptMessage[] {
  const obj = o as CodexLine
  if (obj?.type !== 'response_item') return []
  const p = obj.payload
  if (!p || p.type !== 'message') return []
  const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : null
  if (!role) return []
  const text = (p.content ?? [])
    .filter(
      (c) =>
        !!c &&
        (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') &&
        typeof c.text === 'string'
    )
    .map((c) => c.text as string)
    .join('\n')
    .trim()
  if (!text) return []
  // Codex injects system material (plugins list, permissions, environment)
  // as user-role messages; skip those.
  if (role === 'user' && /^<(recommended_plugins|permissions|environment_context|user_instructions)/.test(text)) {
    return []
  }
  return [{ role, text, ts: Date.parse(obj.timestamp ?? '') || Date.now() }]
}

export function listCodexSessions(dir: string): TranscriptSession[] {
  return buildSessions(
    walkJsonl(dir),
    codexLineMessages,
    (f) => path.basename(f).startsWith('rollout-')
  )
}

export function readCodexSession(file: string): TranscriptMessage[] {
  return readJsonlMessages(file, codexLineMessages)
}

// ---------------------------------------------------------------- Claude Code

interface ClaudeLine {
  type?: string
  isMeta?: boolean
  timestamp?: string
  message?: { role?: string; content?: unknown }
}

function claudeContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((x) => x && typeof (x as { type?: unknown }).type === 'string' && (x as { type: string }).type === 'text')
      .map((x) => String((x as { text?: unknown }).text ?? ''))
      .join('\n')
  }
  return ''
}

export function claudeLineMessages(o: unknown): TranscriptMessage[] {
  const obj = o as ClaudeLine
  const ts = Date.parse(obj?.timestamp ?? '') || Date.now()
  if (obj?.type === 'user' && obj.isMeta !== true) {
    const text = claudeContentText(obj.message?.content).trim()
    if (!text) return []
    if (/^<(command-name|command-message|local-command)/.test(text)) return []
    return [{ role: 'user', text, ts }]
  }
  if (obj?.type === 'assistant') {
    const text = claudeContentText(obj.message?.content).trim()
    if (!text) return []
    return [{ role: 'assistant', text, ts }]
  }
  return []
}

export function listClaudeSessions(dir: string): TranscriptSession[] {
  return buildSessions(
    walkJsonl(dir),
    claudeLineMessages,
    (f) => !path.basename(f).startsWith('agent-')
  )
}

export function readClaudeSession(file: string): TranscriptMessage[] {
  return readJsonlMessages(file, claudeLineMessages)
}

export interface SessionMeta {
  /** The CLI's own session/thread id (used by resume commands). */
  cliSessionId?: string
  /** The working directory the session ran in. */
  cwd?: string
}

/** Read identity/working-dir hints from a transcript head (first matching line). */
export function readSessionMeta(kind: string, file: string): SessionMeta {
  const lines = readHead(file, 65536).split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(t) as Record<string, unknown>
    } catch {
      continue
    }
    if (kind === 'codex') {
      if (obj.type !== 'session_meta') continue
      const p = (obj.payload ?? {}) as Record<string, unknown>
      return {
        cliSessionId: typeof p.id === 'string' ? p.id : undefined,
        cwd: typeof p.cwd === 'string' ? p.cwd : undefined
      }
    }
    if (kind === 'claude') {
      const id = typeof obj.sessionId === 'string' ? obj.sessionId : undefined
      const cwd = typeof obj.cwd === 'string' ? obj.cwd : undefined
      if (id || cwd) return { cliSessionId: id, cwd }
    }
  }
  return {}
}

// ---------------------------------------------------------------- Gemini family (single-JSON)

interface GeminiFile {
  messages?: Array<{ type?: string; content?: unknown; timestamp?: string | number }>
}

/** gemini-cli / qwen-code session JSON → messages (messages[].type: user|gemini|info). */
export function geminiJsonToMessages(json: unknown): TranscriptMessage[] {
  const obj = json as GeminiFile
  const msgs = obj?.messages
  if (!Array.isArray(msgs)) return []
  const out: TranscriptMessage[] = []
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    const role = m.type === 'user' ? 'user' : m.type === 'gemini' ? 'assistant' : null
    if (!role) continue
    const text = typeof m.content === 'string' ? m.content.trim() : ''
    if (!text) continue
    const ts =
      typeof m.timestamp === 'number'
        ? m.timestamp
        : Date.parse(String(m.timestamp ?? '')) || Date.now()
    out.push({ role, text, ts })
  }
  return out.slice(-MAX_MESSAGES)
}

export function readGeminiSession(file: string): TranscriptMessage[] {
  try {
    return geminiJsonToMessages(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return []
  }
}

/** Sessions live under <root>/<project-hash>/chats/session-*.json */
export function listGeminiSessions(dir: string): TranscriptSession[] {
  const files: string[] = []
  const walk = (d: string, depth = 0): void => {
    if (depth > 5) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      try {
        if (e.isDirectory()) walk(full, depth + 1)
        else if (
          e.isFile() &&
          /^session-.*\.json$/i.test(e.name) &&
          path.basename(d).toLowerCase() === 'chats'
        ) {
          files.push(full)
        }
      } catch {
        /* skip */
      }
    }
  }
  walk(dir)
  const entries: Array<{ file: string; mtime: number }> = []
  for (const f of files) {
    try {
      entries.push({ file: f, mtime: fs.statSync(f).mtimeMs })
    } catch {
      /* skip */
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  const out: TranscriptSession[] = []
  for (const { file, mtime } of entries.slice(0, MAX_SESSIONS)) {
    let title = ''
    try {
      const msgs = geminiJsonToMessages(JSON.parse(fs.readFileSync(file, 'utf8')))
      const firstUser = msgs.find((m) => m.role === 'user')
      if (firstUser) title = firstUser.text.replace(/\s+/g, ' ').slice(0, 60)
    } catch {
      /* skip */
    }
    out.push({
      id: path.basename(file, '.json'),
      title: title || '（无标题）',
      updatedAt: mtime,
      file
    })
  }
  return out
}

// ---------------------------------------------------------------- custom (generic JSONL/JSON)

interface GenericLine {
  role?: string
  type?: string
  text?: string
  content?: unknown
  timestamp?: string
  ts?: number | string
  message?: { role?: string; content?: unknown }
}

export function customLineMessages(o: unknown): TranscriptMessage[] {
  const obj = o as GenericLine
  let role: 'user' | 'assistant' | null = null
  if (obj?.role === 'user' || obj?.role === 'assistant') role = obj.role
  else if (obj?.message?.role === 'user' || obj?.message?.role === 'assistant')
    role = obj.message.role as 'user' | 'assistant'
  else if (obj?.type === 'user') role = 'user'
  else if (obj?.type === 'assistant' || obj?.type === 'ai' || obj?.type === 'model') role = 'assistant'
  if (!role) return []
  let text = ''
  // '' must fall through to the next source (?? would short-circuit on it)
  const c = obj.text || obj.content || obj.message?.content
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) {
    text = c
      .map((x) =>
        typeof x === 'string' ? x : typeof (x as { text?: unknown })?.text === 'string' ? String((x as { text: string }).text) : ''
      )
      .join('\n')
  }
  text = text.trim()
  if (!text) return []
  const ts =
    typeof obj.ts === 'number'
      ? obj.ts
      : Date.parse(String(obj.timestamp ?? obj.ts ?? '')) || Date.now()
  return [{ role, text, ts }]
}

export function listCustomSessions(dir: string): TranscriptSession[] {
  const jsonlSessions = buildSessions(walkJsonl(dir), customLineMessages, () => true)
  const seen = new Set(jsonlSessions.map((s) => s.file))
  const jsonSessions = listCustomJsonSessions(dir, seen)
  return [...jsonlSessions, ...jsonSessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS)
}

/** Sessions recorded as whole-file JSON (arrays / {messages:[]} shapes). */
function listCustomJsonSessions(dir: string, seen: Set<string>): TranscriptSession[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: TranscriptSession[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue
    const full = path.join(dir, e.name)
    if (seen.has(full)) continue
    try {
      const msgs = readCustomSession(full)
      if (msgs.length === 0) continue
      const st = fs.statSync(full)
      const firstUser = msgs.find((m) => m.role === 'user')
      out.push({
        id: path.basename(full, '.json'),
        title: firstUser ? firstUser.text.replace(/\s+/g, ' ').slice(0, 60) : '（无标题）',
        updatedAt: st.mtimeMs,
        file: full
      })
    } catch {
      /* skip */
    }
  }
  return out
}

export function readCustomSession(file: string): TranscriptMessage[] {
  let content = ''
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  // Whole-file JSON first (covers gemini-style {messages:[]}, top-level arrays,
  // single objects — and single-line JSONL, which parses as one object).
  try {
    const parsed = JSON.parse(content.trim()) as unknown
    const viaMessages = geminiJsonToMessages(parsed)
    if (viaMessages.length > 0) return viaMessages
    if (Array.isArray(parsed)) {
      const out: TranscriptMessage[] = []
      for (const item of parsed) out.push(...customLineMessages(item))
      if (out.length > 0) return out.slice(-MAX_MESSAGES)
    }
    const single = customLineMessages(parsed)
    if (single.length > 0) return single
  } catch {
    /* not whole-file JSON — treat as JSONL below */
  }
  // Multi-line JSONL: one JSON object per line
  return readJsonlMessages(file, customLineMessages)
}
