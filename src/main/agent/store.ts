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

/** Pure: normalize raw JSON into sessions. */
export function normalizeRawSessions(raw: unknown): AgentSession[] {
  if (!Array.isArray(raw)) return []
  const out: AgentSession[] = []
  for (const item of raw) {
    if (!isValidSession(item)) continue
    const o = item as Record<string, unknown>
    out.push({
      id: String(o.id),
      title: typeof o.title === 'string' && o.title ? o.title : '新对话',
      createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : Date.now(),
      messages: (o.messages as ChatMessage[]).slice(-MAX_MESSAGES),
      uiEvents: (o.uiEvents as Record<string, unknown>[]).slice(-MAX_UI_EVENTS)
    })
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out.slice(0, MAX_SESSIONS)
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

export function loadAgentSessions(): AgentSession[] {
  if (IN_TEST) return []
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8')) as unknown
    return normalizeRawSessions(raw)
  } catch {
    return []
  }
}

export function saveAgentSessions(sessions: AgentSession[]): void {
  if (IN_TEST) return
  try {
    fs.mkdirSync(cobrowseDir(), { recursive: true })
    fs.writeFileSync(sessionsFile(), JSON.stringify(trimSessionsForSave(sessions)), 'utf8')
  } catch {
    /* persistence must never crash the agent */
  }
}
