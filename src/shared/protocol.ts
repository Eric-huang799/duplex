/** Shared protocol types between main process, renderer, and the stdio MCP bridge. */

/** Written by the browser app on startup to ~/.cobrowse/endpoint.json */
export interface EndpointInfo {
  port: number
  token: string
  pid: number
  startedAt: string
  version: string
}

export interface TabInfo {
  id: number
  url: string
  title: string
  loading: boolean
  active: boolean
  canGoBack: boolean
  canGoForward: boolean
  favicon?: string
  /** Page audio is muted (Chrome-style speaker control). */
  audioMuted?: boolean
  /** Page is currently producing audio. */
  audioPlaying?: boolean
}

export interface BookmarkRecord { url: string; title: string; favicon?: string; addedAt: number; folder?: string }
export interface HistoryRecord { url: string; title: string; visitedAt: number; favicon?: string }
export interface DownloadRecord {
  id: string; filename: string; path: string; url: string
  state: 'progressing' | 'completed' | 'interrupted' | 'cancelled'
  receivedBytes: number; totalBytes: number; startedAt: number; endedAt?: number
}
export interface BrowserDataSnapshot {
  bookmarks: BookmarkRecord[]
  /** User-created bookmark folder names (bookmarks without a folder live at the root). */
  bookmarkFolders: string[]
  history: HistoryRecord[]
  downloads: DownloadRecord[]
}

/** Events mirrored from the opencode session into the browser side panel. */
export type MirrorEvent =
  | MirrorTextEvent
  | MirrorReasoningEvent
  | MirrorToolEvent
  | MirrorSessionEvent
  | MirrorAnnotationEvent
  | MirrorSessionInfoEvent

export interface MirrorTextEvent {
  id: number
  kind: 'text'
  sessionID: string
  messageID: string
  partID: string
  role: 'user' | 'assistant'
  text: string
  done: boolean
  ts: number
}

export interface MirrorReasoningEvent {
  id: number
  kind: 'reasoning'
  sessionID: string
  messageID: string
  partID: string
  text: string
  done: boolean
  ts: number
}

export type ToolStatus = 'pending' | 'running' | 'completed' | 'error'

export interface MirrorToolEvent {
  id: number
  kind: 'tool'
  sessionID: string
  messageID: string
  partID: string
  tool: string
  callID: string
  status: ToolStatus
  title?: string
  input?: unknown
  output?: string
  error?: string
  ts: number
}

export type AnnotationTool = 'rect' | 'circle' | 'arrow' | 'point'

export interface SessionSummary {
  id: string
  title: string
  updated: number
}

/** Session connection state pushed by the opencode plugin to the panel. */
export interface MirrorSessionInfoEvent {
  id: number
  kind: 'session-info'
  activeSessionID: string | null
  activeTitle?: string
  sessions?: SessionSummary[]
  reason?: 'listed' | 'selected' | 'created' | 'auto'
  ts: number
}

/** A human page-annotation submitted from the overlay (shown in the side panel). */
export interface MirrorAnnotationEvent {
  id: number
  kind: 'annotation'
  annotationId: string
  text: string
  question?: string
  tool: AnnotationTool
  url: string
  summary: string
  elementCount: number
  source?: 'opencode' | 'agent'
  ts: number
}

/** Main → renderer: page load failed (shown as a toast with retry). */
export interface LoadErrorInfo {
  tabId: number
  url: string
  code: number
  desc: string
}

export interface MirrorSessionEvent {
  id: number
  kind: 'session'
  sessionID: string
  status: 'idle' | 'busy' | 'error'
  error?: string
  ts: number
}

/** Message queued in the browser, waiting to be injected into the opencode session. */
export interface Injection {
  id: string
  text: string
  createdAt: number
  source: 'panel' | 'annotation' | 'api'
  targetSessionID?: string | null
  consumerID?: string
  generation?: number
}

export interface CollaborationTabState {
  tabId: number
  owner: string | null
  paused: boolean
  reason: string | null
  scrolling: boolean
}

export interface CollaborationState {
  tabs: CollaborationTabState[]
}

export interface ExternalSessionState {
  toolId: string
  sessionId: string
  title: string
  file: string
}

/** Result of chat:send — warning is set when no AI consumer is connected. */
export interface ChatSendResult {
  ok: boolean
  id?: string
  warning?: string
}

/** Events sent from main process to renderer. */
export interface StateSnapshot {
  tabs: TabInfo[]
  activeTabId: number | null
  mirror: MirrorEvent[]
}

export interface ContentBounds {
  x: number
  y: number
  width: number
  height: number
}
