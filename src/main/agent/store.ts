/**
 * Persistence for built-in agent conversations.
 * Stored in ~/.cobrowse/agent-sessions.json (capped, human-inspectable).
 */
import fs from 'node:fs'
import path from 'node:path'
import { cobrowseDir } from '../../shared/endpoint'
import type { ChatMessage } from './llm'

export interface AgentSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  uiEvents: Record<string, unknown>[]
}

const MAX_SESSIONS = 50
const MAX_MESSAGES = 200
const MAX_UI_EVENTS = 500

// Safety net: unit tests must NEVER touch the user's real conversation store,
// even if a test forgets to inject a mock store.
const IN_TEST = typeof process !== 'undefined' && !!process.env.VITEST

function sessionsFile(): string {
  return path.join(cobrowseDir(), 'agent-sessions.json')
}

function isValidSession(s: unknown): boolean {
  if (!s || typeof s !== 'object') return false
  const o = s as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    Array.isArray(o.messages) &&
    Array.isArray(o.uiEvents)
  )
}

export interface NormalizedSessions {
  sessions: AgentSession[]
  /** IDs of sessions whose messages/uiEvents were cut by the storage caps. */
  truncatedIds: Set<string>
}

/** Pure: normalize raw JSON into sessions, plus which ones hit the caps. */
export function normalizeRawSessionsWithMeta(raw: unknown): NormalizedSessions {
  if (!Array.isArray(raw)) return { sessions: [], truncatedIds: new Set() }
  const out: AgentSession[] = []
  const truncatedIds = new Set<string>()
  for (const item of raw) {
    if (!isValidSession(item)) continue
    const o = item as Record<string, unknown>
    const id = String(o.id)
    const messages = o.messages as ChatMessage[]
    const uiEvents = o.uiEvents as Record<string, unknown>[]
    if (messages.length > MAX_MESSAGES || uiEvents.length > MAX_UI_EVENTS) truncatedIds.add(id)
    out.push({
      id,
      title: typeof o.title === 'string' && o.title ? o.title : '新对话',
      createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : Date.now(),
      messages: messages.slice(-MAX_MESSAGES),
      uiEvents: uiEvents.slice(-MAX_UI_EVENTS)
    })
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return { sessions: out.slice(0, MAX_SESSIONS), truncatedIds }
}

/** Pure: normalize raw JSON into sessions. */
export function normalizeRawSessions(raw: unknown): AgentSession[] {
  return normalizeRawSessionsWithMeta(raw).sessions
}

/** Pure: trim a session list for saving (keeps system prompt + tail). */
export function trimSessionsForSave(sessions: AgentSession[]): AgentSession[] {
  return sessions.slice(0, MAX_SESSIONS).map((s) => {
    const msgs = s.messages
    const sys = msgs.length > 0 && msgs[0].role === 'system' ? msgs[0] : null
    let tail = msgs.slice(-MAX_MESSAGES)
    if (sys && tail[0] !== sys) tail = [sys, ...tail.slice(-(MAX_MESSAGES - 1))]
    return {
      ...s,
      messages: tail,
      uiEvents: s.uiEvents.slice(-MAX_UI_EVENTS)
    }
  })
}

/** Human-readable summary of the caps a raw/session list exceeds (empty = none). */
function capViolations(raw: unknown): string[] {
  const notes: string[] = []
  if (!Array.isArray(raw)) return notes
  if (raw.length > MAX_SESSIONS) notes.push(`会话数 ${raw.length} 超过上限 ${MAX_SESSIONS}`)
  let overMessages = 0
  let overEvents = 0
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (Array.isArray(o.messages) && o.messages.length > MAX_MESSAGES) overMessages++
    if (Array.isArray(o.uiEvents) && o.uiEvents.length > MAX_UI_EVENTS) overEvents++
  }
  if (overMessages > 0) notes.push(`${overMessages} 个会话的消息数超过 ${MAX_MESSAGES}`)
  if (overEvents > 0) notes.push(`${overEvents} 个会话的 UI 事件数超过 ${MAX_UI_EVENTS}`)
  return notes
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
}

/** Copy the current store to agent-sessions.json.bak when it is non-empty and parseable. */
function refreshBackup(file: string): void {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return
  }
  if (!stat.isFile() || stat.size === 0) return
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.copyFileSync(file, `${file}.bak`)
  } catch {
    console.error('[agent-store] 会话文件无法解析，保留已有 .bak 不覆盖')
  }
}

/** Atomic write: same-directory tmp file + rename. */
function atomicWrite(file: string, data: string): void {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.agent-sessions-${process.pid}-${Date.now().toString(36)}.tmp`)
  try {
    fs.writeFileSync(tmp, data, 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* tmp cleanup is best-effort */
    }
    throw e
  }
}

export interface LoadedAgentSessions {
  sessions: AgentSession[]
  /** IDs of sessions whose history was cut by the storage caps during this load. */
  truncatedIds: Set<string>
}

export function loadAgentSessionsWithMeta(): LoadedAgentSessions {
  if (IN_TEST) return { sessions: [], truncatedIds: new Set() }
  const file = sessionsFile()
  let raw: unknown
  try {
    raw = readJson(file)
  } catch {
    try {
      raw = readJson(`${file}.bak`)
      console.error('[agent-store] 会话主文件读取失败，已回退读取 agent-sessions.json.bak')
    } catch {
      return { sessions: [], truncatedIds: new Set() }
    }
  }
  const notes = capViolations(raw)
  if (notes.length > 0) {
    console.error(`[agent-store] 加载时按上限截断：${notes.join('；')}`)
  }
  return normalizeRawSessionsWithMeta(raw)
}

export function loadAgentSessions(): AgentSession[] {
  return loadAgentSessionsWithMeta().sessions
}

export function saveAgentSessions(sessions: AgentSession[]): void {
  if (IN_TEST) return
  const file = sessionsFile()
  try {
    fs.mkdirSync(cobrowseDir(), { recursive: true })
    const notes = capViolations(sessions)
    if (notes.length > 0) {
      console.error(`[agent-store] 持久化前按上限截断：${notes.join('；')}`)
    }
    const trimmed = trimSessionsForSave(sessions)
    refreshBackup(file)
    atomicWrite(file, JSON.stringify(trimmed))
  } catch {
    /* persistence must never crash the agent */
  }
}
