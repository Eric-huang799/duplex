import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  session,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { TabManager, type PageContextMenuInfo, type Tab } from './tabs'
import { BrowserDataStore } from './browser-data'
import { DownloadManager } from './downloads'
import { MirrorStore } from './mirror'
import { createToolExecutor, type ToolExecutor } from './tool-handlers'
import { startHttpServer, type RunningHttpServer } from './http-server'
import {
  hideAllVisuals,
  isAiPaused,
  overlaySend,
  pauseAi,
  resumeAi
} from './overlay'
import { abortOperation, beginOperation, endOperation, runInOperation } from './interrupt'
import {
  createAnnotationSubmitHandler,
  type AnnotationDelivery,
  type AnnotationSubmitHandler,
  type AnnotationSubmitPayload
} from './annotations'
import { cobrowseDir, removeEndpoint, writeEndpoint } from '../shared/endpoint'
import { normalizeBinding, validateBinding } from '../shared/hotkeys'
import {
  DEFAULT_SHORTCUTS,
  bindingConflicts,
  effectiveShortcuts,
  isShortcutAction,
  shortcutLabel,
  validateShortcuts
} from '../shared/shortcuts'
import {
  activeAgentConfig,
  loadSettings,
  saveAiPaused,
  saveConfirmBeforeDownload,
  saveEmergencyStopKeys,
  saveProviders,
  saveSearchEngine,
  saveSession,
  saveShortcuts,
  saveTheme,
  type AgentConfig,
  type ThemeSetting
} from './settings'
import {
  deriveName,
  maskProviders,
  mergeProviders,
  newProviderId,
  providersFromOpencode
} from './agent/providers'
import { SessionBus } from './session-bus'
import { AgentRuntime } from './agent/runtime'
import { createSkillToolHandlers } from './agent/skill-tools'
import { createFsToolHandlers } from './agent/fs-tools'
import { importSkillFromFolder, listSkills, removeSkill, setSkillEnabled } from './agent/skills'
import { importStatus } from './agent/auth-import'
import {
  claudeDesktopConfigHint,
  claudeMcpCommand,
  codexConfigStatus,
  installCodexMcp
} from './integrations/setup'
import {
  addCustomAgent,
  buildResumePlan,
  buildStartPlan,
  findAgentTool,
  getToolModel,
  listAgentTools,
  listCandidateModels,
  removeCustomAgent,
  setToolModel,
  syncModelToGlobal
} from './integrations/agents'
import {
  claudeLineMessages,
  codexLineMessages,
  customLineMessages,
  listClaudeSessions,
  listCodexSessions,
  listCustomSessions,
  listGeminiSessions,
  readClaudeSession,
  readCodexSession,
  readCustomSession,
  readGeminiSession,
  readSessionMeta,
  type TranscriptMessage
} from './integrations/transcripts'
import { resolveAddress } from '../shared/url'
import { SEARCH_ENGINES, searchUrl, type SearchEngine } from '../shared/search'
import { isTrustedImportedHost } from '../shared/trusted-hosts'
import type { ChatSendResult, ContentBounds } from '../shared/protocol'
import { isLlmProtocol } from '../shared/llm'

const VERSION = '0.2.6'
const TOKEN = crypto.randomBytes(24).toString('hex')
const LOG_FILE = path.join(cobrowseDir(), 'app.log')

function logLine(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.error(line)
  try {
    fs.mkdirSync(cobrowseDir(), { recursive: true })
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1_000_000) {
      fs.rmSync(LOG_FILE, { force: true })
    }
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch {
    /* logging must never crash the app */
  }
}

let win: BrowserWindow | null = null
let tabs: TabManager | null = null
let httpServer: RunningHttpServer | null = null
let annotationSubmitHandler: AnnotationSubmitHandler | null = null
let browserData: BrowserDataStore
let downloads: DownloadManager

/** Which panel is on screen — decides where annotations are delivered. */
let currentPanelMode: 'opencode' | 'agent' | 'external' = 'agent'
/** Per-tab annotation-mode state (mirrors each page overlay's own toggle). */
const annotationTabState = new Map<number, boolean>()
/** elementCount by annotationId, attached to the submit-result ack. */
const annotationElementCounts = new Map<string, number>()
let lastActiveTabId: number | null = null

/** Locate the tab whose WebContents sent an overlay event. */
function findTabIdBySender(sender: WebContents): number | null {
  if (!tabs) return null
  for (const info of tabs.list()) {
    const t = tabs.getTab(info.id)
    if (t && !t.view.webContents.isDestroyed() && t.view.webContents.id === sender.id) {
      return t.id
    }
  }
  return null
}

function sendAnnotationState(active: boolean): void {
  try {
    win?.webContents.send('annotation:state', active)
  } catch {
    /* window is going away */
  }
}

/** Debounced push of the browser-data snapshot (rapid history updates coalesce). */
let emitBrowserDataTimer: ReturnType<typeof setTimeout> | null = null
function emitBrowserData(): void {
  if (emitBrowserDataTimer) return
  emitBrowserDataTimer = setTimeout(() => {
    emitBrowserDataTimer = null
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('browser:data-update', browserData.snapshot())
    }
  }, 250)
}

// script-execution confirmation round trip (run_skill_script → renderer dialog);
// module scope so both the agent wiring and the IPC handlers can reach it
const pendingConfirms = new Map<number, (ok: boolean) => void>()
let confirmSeq = 0
const confirmScript = (payload: {
  command: string
  cwd: string
  skill: string
  tool?: string
  kind?: 'write' | 'command' | 'script'
  preview?: string
}): Promise<boolean> =>
  new Promise((resolve) => {
    const id = ++confirmSeq
    pendingConfirms.set(id, resolve)
    win?.webContents.send('agent:confirm-request', {
      id,
      ...payload,
      expiresAt: Date.now() + 120_000
    })
    setTimeout(() => {
      if (pendingConfirms.delete(id)) {
        resolve(false)
        try {
          win?.webContents.send('agent:confirm-cancel', { id })
        } catch {
          /* window is going away */
        }
      }
    }, 120_000)
  })
const skillHandlers = createSkillToolHandlers(confirmScript)

const fsHandlers = createFsToolHandlers((payload) =>
  new Promise<boolean>((resolve) => {
    const id = ++confirmSeq
    pendingConfirms.set(id, resolve)
    win?.webContents.send('agent:confirm-request', {
      id,
      command: payload.kind === 'write' ? `写入文件：${payload.detail}` : payload.detail,
      cwd: payload.cwd,
      skill: payload.kind === 'write' ? 'write_file（写文件）' : 'run_command（执行命令）',
      tool: payload.kind === 'write' ? 'write_file' : 'run_command',
      kind: payload.kind,
      ...(payload.preview ? { preview: payload.preview } : {}),
      expiresAt: Date.now() + 120_000
    })
    setTimeout(() => {
      if (pendingConfirms.delete(id)) {
        resolve(false)
        try {
          win?.webContents.send('agent:confirm-cancel', { id })
        } catch {
          /* window is going away */
        }
      }
    }, 120_000)
  })
)

// external agent transcripts: history replay + live tail, plus panel replies
// (Codex `exec resume` / Claude Code `--resume` write back to the same transcript)
let agentWatch: AgentWatchState | null = null
let externalEvtSeq = 5_000_000
/** While an external transcript is open, opencode pushes are muted. */
let mirrorSource: 'opencode' | 'external' = 'opencode'

/** The external transcript currently open in the panel (reply target). */
let currentExternalSession: { toolId: string; kind: string; sessionId: string; file: string } | null =
  null

/** User message just injected via resume — the CLI transcript will echo it; skip that echo. */
let pendingUserEcho: { text: string; since: number } | null = null

/** Live tail state for one external transcript file. */
interface AgentWatchState {
  kind: string
  file: string
  sessionID: string
  toolId: string
  lastSize: number
  /** Message keys already streamed for this file (survives offset resets). */
  emitted: Set<string>
  statMisses: number
  tailErrors: number
  restarts: number
  timer: ReturnType<typeof setTimeout> | null
}

const TAIL_ERROR_LIMIT = 5
const MAX_WATCH_RESTARTS = 3
const STAT_RETRY_DELAYS = [1000, 2000, 5000]

function stopAgentWatch(): void {
  if (agentWatch?.timer) clearTimeout(agentWatch.timer)
  agentWatch = null
}

function emitWatchError(toolId: string, error: string): void {
  logLine(`[agents:watch] ${toolId}: ${error}`)
  try {
    win?.webContents.send('agents:watch-error', { toolId, error })
  } catch {
    /* the window may be going away */
  }
}

function externalEvent(o: Record<string, unknown>): Record<string, unknown> {
  return { ...o, id: externalEvtSeq++ }
}

function transcriptToMirrorEvent(m: TranscriptMessage, sessionID: string): Record<string, unknown> {
  return externalEvent({
    kind: 'text',
    sessionID,
    messageID: sessionID,
    partID: `x${externalEvtSeq}`,
    role: m.role,
    text: m.text,
    done: true,
    ts: m.ts
  })
}

function parseTranscriptChunk(kind: string, chunk: string): TranscriptMessage[] {
  const mapper =
    kind === 'codex' ? codexLineMessages : kind === 'claude' ? claudeLineMessages : customLineMessages
  const out: TranscriptMessage[] = []
  for (const line of chunk.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(...mapper(JSON.parse(t)))
    } catch {
      /* skip malformed line */
    }
  }
  return out
}

/**
 * Tail a transcript file; stream newly appended messages into the panel.
 *
 * - stat failures retry with backoff (1s / 2s / 5s); after the last retry an
 *   `agents:watch-error` event is sent instead of failing silently;
 * - repeated tail errors restart the watch (up to three times); after that the
 *   same error event is sent and the watch stops;
 * - a truncated/rotated file resets the read offset, while a per-file message
 *   key set prevents re-emitting content already shown.
 */
function startAgentWatch(
  kind: string,
  file: string,
  sessionID: string,
  toolId: string,
  baselineSize?: number,
  carry?: { lastSize: number; emitted: Set<string>; restarts: number }
): void {
  stopAgentWatch()
  const state: AgentWatchState = {
    kind,
    file,
    sessionID,
    toolId,
    lastSize: carry ? carry.lastSize : (baselineSize ?? -1),
    emitted: carry ? carry.emitted : new Set<string>(),
    statMisses: 0,
    tailErrors: 0,
    restarts: carry ? carry.restarts : 0,
    timer: null
  }
  agentWatch = state
  state.timer = setTimeout(() => watchTick(state), state.lastSize < 0 ? 500 : 1500)
}

function watchTick(state: AgentWatchState): void {
  if (agentWatch !== state) return
  const schedule = (ms: number): void => {
    if (agentWatch === state) state.timer = setTimeout(() => watchTick(state), ms)
  }

  let st: fs.Stats
  try {
    st = fs.statSync(state.file)
    state.statMisses = 0
  } catch (e) {
    const delay = STAT_RETRY_DELAYS[state.statMisses] ?? 5000
    state.statMisses++
    if (state.statMisses > STAT_RETRY_DELAYS.length) {
      emitWatchError(
        state.toolId,
        `无法读取会话文件（${(e as Error)?.message ?? String(e)}）：${state.file}`
      )
      stopAgentWatch()
      return
    }
    schedule(delay)
    return
  }

  // the first successful stat defines the baseline when no size was captured
  if (state.lastSize < 0) state.lastSize = st.size

  try {
    if (st.size < state.lastSize) {
      // file was truncated or rotated — restart from the beginning; the
      // emitted-key set below keeps already streamed messages from repeating
      state.lastSize = 0
    }
    if (st.size > state.lastSize) {
      const fd = fs.openSync(state.file, 'r')
      let text = ''
      try {
        const len = st.size - state.lastSize
        const buf = Buffer.alloc(len)
        const n = fs.readSync(fd, buf, 0, len, state.lastSize)
        text = buf.subarray(0, n).toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
      const cut = text.lastIndexOf('\n')
      if (cut >= 0) {
        const complete = text.slice(0, cut + 1)
        state.lastSize += Buffer.byteLength(complete, 'utf8')
        for (const m of parseTranscriptChunk(state.kind, complete)) {
          const key = `${m.role}\u0000${m.ts}\u0000${m.text}`
          if (state.emitted.has(key)) continue
          state.emitted.add(key)
          if (
            m.role === 'user' &&
            pendingUserEcho &&
            m.text === pendingUserEcho.text &&
            m.ts >= pendingUserEcho.since - 15_000
          ) {
            // the CLI transcript echoed a message we already showed optimistically
            pendingUserEcho = null
            continue
          }
          win?.webContents.send('mirror:event', transcriptToMirrorEvent(m, state.sessionID))
        }
        if (state.emitted.size > 5000) {
          state.emitted = new Set(Array.from(state.emitted).slice(-2500))
        }
      }
    }
    state.tailErrors = 0
  } catch (e) {
    state.tailErrors++
    if (state.tailErrors >= TAIL_ERROR_LIMIT) {
      if (state.restarts < MAX_WATCH_RESTARTS) {
        // restart the watch from the last known offset (bounded retries)
        startAgentWatch(state.kind, state.file, state.sessionID, state.toolId, state.lastSize, {
          lastSize: state.lastSize,
          emitted: state.emitted,
          restarts: state.restarts + 1
        })
        return
      }
      emitWatchError(
        state.toolId,
        `会话文件跟踪连续出错，已停止监听（${(e as Error)?.message ?? String(e)}）：${state.file}`
      )
      stopAgentWatch()
      return
    }
  }
  schedule(1500)
}

/**
 * Resolve a session's real title from its transcript metadata (the first user
 * message, computed by the list readers); '' when it cannot be resolved.
 */
function externalSessionTitle(
  tool: { kind: string; sessionsDir?: string },
  sessionId: string,
  resolvedFile: string
): string {
  if (!tool.sessionsDir) return ''
  try {
    const list =
      tool.kind === 'codex'
        ? listCodexSessions(tool.sessionsDir)
        : tool.kind === 'claude'
          ? listClaudeSessions(tool.sessionsDir)
          : tool.kind === 'gemini' || tool.kind === 'qwen'
            ? listGeminiSessions(tool.sessionsDir)
            : listCustomSessions(tool.sessionsDir)
    const hit =
      list.find((s) => path.resolve(s.file) === resolvedFile) ??
      list.find((s) => s.id === sessionId)
    return hit?.title ?? ''
  } catch {
    return ''
  }
}

/** Open a transcript file: reset the panel, stream history, then tail live. */
function openExternalSession(
  tool: { id: string; kind: string; sessionsDir?: string },
  sessionId: string,
  file: string
): { ok: boolean; count?: number; title?: string; error?: string } {
  const root = path.resolve(tool.sessionsDir ?? '')
  const resolvedFile = path.resolve(file)
  const resolvedRoot = path.resolve(root)
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(rootWithSep)) {
    return { ok: false, error: '非法路径' }
  }
  stopAgentWatch()
  mirrorSource = 'external'
  currentExternalSession = { toolId: tool.id, kind: tool.kind, sessionId, file }
  pendingUserEcho = null
  const sid = `${tool.id}:${String(sessionId)}`
  // capture the tail baseline BEFORE reading history so nothing in between
  // is lost (messages appended during the read will still be tailed)
  let baseline = 0
  try {
    baseline = fs.statSync(file).size
  } catch {
    /* ignore */
  }
  const msgs =
    tool.kind === 'codex'
      ? readCodexSession(file)
      : tool.kind === 'claude'
        ? readClaudeSession(file)
        : tool.kind === 'gemini' || tool.kind === 'qwen'
          ? readGeminiSession(file)
          : readCustomSession(file)
  // real session title from transcript metadata; file basename only as fallback
  const title = externalSessionTitle(tool, String(sessionId), resolvedFile) || path.basename(file)
  win?.webContents.send(
    'mirror:event',
    externalEvent({
      kind: 'session-info',
      activeSessionID: sid,
      activeTitle: title,
      reason: 'selected',
      ts: Date.now()
    })
  )
  for (const m of msgs) {
    win?.webContents.send('mirror:event', transcriptToMirrorEvent(m, sid))
  }
  startAgentWatch(tool.kind, file, sid, tool.id, baseline)
  return { ok: true, count: msgs.length, title }
}

/** A spawned external-agent child plus the state needed to explain failures. */
interface LiveChild {
  child: ReturnType<typeof spawn>
  toolId: string
  /** Last ~2KB of stderr (ring buffer). */
  stderrTail: string
  exited: boolean
  exitCode: number | null
  spawnError?: string
  /** Set when we terminated the process ourselves. */
  killed: boolean
  /** Resolves when the process exits or fails to spawn. */
  settled: Promise<void>
  markSettled: () => void
}

/** Live child processes spawned for external sessions (killed on quit). */
const liveChildren = new Set<LiveChild>()
let startSessionCancelled = false

function broadcastChildren(): void {
  win?.webContents.send('agents:children', liveChildren.size)
}

/** Track a spawned child: stderr ring buffer, exit/error state, set bookkeeping. */
function trackChild(child: ReturnType<typeof spawn>, toolId: string): LiveChild {
  let markSettled = (): void => {}
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve
  })
  const entry: LiveChild = {
    child,
    toolId,
    stderrTail: '',
    exited: false,
    exitCode: null,
    killed: false,
    settled,
    markSettled
  }
  const finish = (): void => {
    entry.markSettled()
    liveChildren.delete(entry)
    broadcastChildren()
  }
  child.stderr?.on('data', (d: Buffer) => {
    entry.stderrTail = (entry.stderrTail + d.toString('utf8')).slice(-2048)
  })
  child.on('error', (e: Error) => {
    entry.spawnError = e?.message ?? String(e)
    entry.exited = true
    finish()
  })
  child.on('exit', (code) => {
    entry.exited = true
    entry.exitCode = code
    finish()
  })
  liveChildren.add(entry)
  broadcastChildren()
  return entry
}

/** Last non-empty stderr line, appended to failure messages when present. */
function stderrSummary(entry: LiveChild): string {
  const lines = entry.stderrTail
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const last = lines[lines.length - 1]
  return last ? `；最近输出：${last.slice(0, 300)}` : ''
}

/** Kill a child and its whole process tree (Windows grandchildren included). */
function killChildTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Kill external-session children. With a toolId only that tool's processes are
 * terminated (panel "stop" for one tool); without one every child is killed
 * (emergency stop).
 */
function stopExternalChildren(toolId?: string): number {
  if (!toolId) startSessionCancelled = true
  let killed = 0
  for (const entry of [...liveChildren]) {
    if (toolId && entry.toolId !== toolId) continue
    entry.killed = true
    killChildTree(entry.child)
    liveChildren.delete(entry)
    killed++
  }
  broadcastChildren()
  return killed
}

/** A user message (panel / built-in agent / external session) resumes after an emergency stop. */
function maybeResumeAi(): void {
  if (resumeAi()) {
    saveAiPaused(false)
    try {
      win?.webContents.send('emergency:state', { paused: false })
    } catch {
      /* window is going away */
    }
    logLine('[takeover] AI resumed by user action')
  }
}

/** Emergency stop dismisses every confirmation dialog still waiting for an answer. */
function denyAllPendingConfirms(): number {
  let n = 0
  for (const [id, resolve] of pendingConfirms) {
    pendingConfirms.delete(id)
    resolve(false)
    n++
  }
  return n
}

/** Spawn a headless CLI run that starts a brand-new session (generalized). */
function startExternalSessionSpawn(
  tool: { id?: string; kind: string; command?: string },
  message: string,
  model?: string
): { ok: true; live: LiveChild } | { ok: false; error: string } {
  const plan = buildStartPlan(tool as never, message, model)
  if ('error' in plan) return { ok: false, error: plan.error }
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    })
  } catch (e) {
    return { ok: false, error: `启动失败：${(e as Error)?.message ?? String(e)}` }
  }
  const live = trackChild(child, tool.id ?? tool.kind)
  // a broken pipe / missing binary must never crash the main process
  child.stdin?.on('error', () => undefined)
  if (plan.useStdin) {
    try {
      child.stdin?.write(message)
    } catch {
      /* child may already be gone */
    }
  }
  child.stdin?.end()
  return { ok: true, live }
}

/** Spawn a headless CLI run that CONTINUES an existing session ("reply from the panel"). */
function resumeExternalSessionSpawn(
  tool: { id?: string; kind: string },
  cliSessionId: string,
  cwdHint: string,
  message: string,
  sessionID: string,
  model?: string
): { ok: true; live: LiveChild } | { ok: false; error: string } {
  const plan = buildResumePlan(tool as never, cliSessionId, cwdHint, model)
  if ('error' in plan) return { ok: false, error: plan.error }
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    })
  } catch (e) {
    return { ok: false, error: `启动失败：${(e as Error)?.message ?? String(e)}` }
  }
  const live = trackChild(child, tool.id ?? tool.kind)
  const toolLabel =
    tool.kind === 'codex' ? 'Codex' : tool.kind === 'claude' ? 'Claude Code' : tool.kind
  child.on('error', (e: Error) => {
    // spawn failed asynchronously: drop the pending echo and tell the panel
    if (pendingUserEcho && pendingUserEcho.text === message) pendingUserEcho = null
    win?.webContents.send(
      'mirror:event',
      externalEvent({
        kind: 'session',
        status: 'error',
        sessionID,
        error: `发送失败：无法启动 ${toolLabel}（${e?.message ?? String(e)}）`,
        ts: Date.now()
      })
    )
  })
  child.on('exit', (code) => {
    const detail = live.stderrTail.trim()
    if (code !== 0 && detail) {
      win?.webContents.send(
        'mirror:event',
        externalEvent({
          kind: 'session',
          status: 'error',
          sessionID,
          error: detail.split('\n').slice(-3).join('\n'),
          ts: Date.now()
        })
      )
    }
  })
  child.stdin?.on('error', () => undefined)
  try {
    child.stdin?.write(message)
  } catch {
    /* child may already be gone */
  }
  child.stdin?.end()
  return { ok: true, live }
}
let acrylicWindow = false
let agentRuntime: AgentRuntime | null = null

/** Absolute path of the MCP bridge entry point external CLIs (node) will execute. */
function bridgeCjsPath(): string {
  const root = app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath()
  return path.join(root, 'dist-bridge', 'index.cjs')
}
const mirror = new MirrorStore()
const sessionBus = new SessionBus()

if (process.env['DUPLEX_DATA_DIR']) {
  const previewData = path.resolve(process.env['DUPLEX_DATA_DIR'])
  fs.mkdirSync(previewData, { recursive: true })
  app.setPath('userData', path.join(previewData, 'electron'))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  void app.whenReady().then(start)
}

async function start(): Promise<void> {
  app.setAppUserModelId('Duplex')
  browserData = new BrowserDataStore(cobrowseDir())
  downloads = new DownloadManager(
    session.fromPartition('persist:cobrowse'),
    browserData,
    (rows) => {
      if (win && !win.isDestroyed()) win.webContents.send('downloads:update', rows)
    },
    () => loadSettings().confirmBeforeDownload
  )
  const settings = loadSettings()
  nativeTheme.themeSource = settings.theme
  if (settings.aiPaused) {
    // the emergency stop survives restarts until the user explicitly resumes
    pauseAi()
    logLine('[takeover] emergency stop restored from settings')
  }
  logLine(`[duplex] theme source: ${settings.theme}`)
  nativeTheme.on('updated', () => applyWindowBackground())
  setupIpc()
  createWindow()

  // restore the previously connected session (panel shows its context)
  if (settings.session) {
    sessionBus.select({ sessionID: settings.session.id, title: settings.session.title })
    mirror.add({
      kind: 'session-info',
      activeSessionID: settings.session.id,
      activeTitle: settings.session.title || undefined,
      reason: 'selected'
    })
    sessionBus.push({ action: 'history', sessionID: settings.session.id })
    logLine(`[session] restored ${settings.session.id}`)
  }

  const execute = createToolExecutor(tabs!, {
    getSearchEngine: () => loadSettings().searchEngine
  })
  const executeWithWake: ToolExecutor = async (name, args) => {
    if (isAiPaused()) {
      logLine('[takeover] AI paused (emergency stop); tool call rejected')
      return {
        content: [
          {
            type: 'text',
            text: '已急停挂起：暂时不接受任何 AI 操作。请停止动作，等待用户恢复（发送消息或点击「恢复」继续）。不要重试。'
          }
        ]
      }
    }
    if (win && win.isMinimized()) win.restore()
    const ac = beginOperation()
    try {
      return await runInOperation(ac, () => execute(name, args))
    } finally {
      endOperation(ac)
    }
  }

  // skill tools (read_skill / run_skill_script / run_command …) are only wired
  // into the built-in agent path; they go through the same emergency-stop gate
  // and run inside an abortable operation context
  const executeWithSkills: ToolExecutor = async (name, args) => {
    const h = skillHandlers[name] ?? fsHandlers[name]
    if (!h) return executeWithWake(name, args)
    if (isAiPaused()) {
      logLine('[takeover] AI paused (emergency stop); tool call rejected')
      return {
        content: [
          {
            type: 'text',
            text: '已急停挂起：暂时不接受任何 AI 操作。请停止动作，等待用户恢复（发送消息或点击「恢复」继续）。不要重试。'
          }
        ]
      }
    }
    const ac = beginOperation()
    try {
      return await runInOperation(ac, () => h(args))
    } finally {
      endOperation(ac)
    }
  }

  // built-in agent mode (optional alternative to the opencode path)
  const requireAgentConfig = (): AgentConfig => {
    const cfg = activeAgentConfig()
    if (!cfg) {
      throw new Error('当前模型配置不存在，请在 ⚙ 模型配置里选择或新建')
    }
    return cfg
  }
  agentRuntime = new AgentRuntime(
    executeWithSkills,
    requireAgentConfig,
    (ev) => {
      win?.webContents.send('agent:event', ev)
    }
  )

  httpServer = await startHttpServer({
    token: TOKEN,
    version: VERSION,
    mirror,
    tabs: tabs!,
    executeTool: executeWithWake,
    sessionBus,
    sendAgent: async (text) => {
      return await agentRuntime?.send(text)
    },
    agentBusy: () => agentRuntime?.isRunning ?? false,
    onUserActivity: () => maybeResumeAi(),
    resumeAi: () => maybeResumeAi(),
    uiAction:
      process.env['COBROWSE_DEBUG_UI'] === '1'
        ? (action: string) => {
            try {
              win?.webContents.send('browser:shortcut', action)
            } catch {
              /* window is going away */
            }
          }
        : undefined,
    mirrorGate: () => mirrorSource === 'opencode',
    captureUI: async () => {
      try {
        const img = await win?.webContents.capturePage()
        if (!img) return null
        const file = path.join(cobrowseDir(), 'ui-snapshot.png')
        fs.writeFileSync(file, img.toPNG())
        return file
      } catch {
        return null
      }
    },
    panelEval:
      process.env['COBROWSE_DEBUG_UI'] === '1'
        ? (js: string) => win!.webContents.executeJavaScript(js)
        : undefined,
    debugExec:
      process.env['COBROWSE_DEBUG_UI'] === '1'
        ? async (target, js) => {
            const wc =
              target === 'page' ? tabs?.getActive()?.view.webContents : win?.webContents
            if (!wc || wc.isDestroyed()) throw new Error(`no webContents for ${target}`)
            return wc.executeJavaScript(js)
          }
        : undefined,
    debugKey:
      process.env['COBROWSE_DEBUG_UI'] === '1'
        ? async (target, key, modifiers = []) => {
            const wc =
              target === 'page' ? tabs?.getActive()?.view.webContents : win?.webContents
            if (!wc || wc.isDestroyed()) throw new Error(`no webContents for ${target}`)
            wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
            wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
          }
        : undefined,
    debugType:
      process.env['COBROWSE_DEBUG_UI'] === '1'
        ? async (target, text, delayMs = 50) => {
            const wc =
              target === 'page' ? tabs?.getActive()?.view.webContents : win?.webContents
            if (!wc || wc.isDestroyed()) throw new Error(`no webContents for ${target}`)
            for (const ch of text) {
              wc.sendInputEvent({ type: 'char', keyCode: ch })
              await new Promise((resolve) => setTimeout(resolve, delayMs))
            }
          }
        : undefined
  })

  // Annotation routing: in built-in-agent mode the annotation goes straight
  // into the agent conversation; opencode / external panels get the default
  // queue + side-panel mirror delivery.
  const deliverAnnotation = (d: AnnotationDelivery): void => {
    if (annotationElementCounts.size > 100) annotationElementCounts.clear()
    annotationElementCounts.set(d.annotationId, d.elementCount)
    if (currentPanelMode === 'agent' && agentRuntime) {
      try {
        agentRuntime.injectAnnotation(d.text, {
          question: d.question,
          summary: d.summary,
          url: d.url,
          annotationId: d.annotationId,
          tool: d.tool,
          elementCount: d.elementCount
        })
        return
      } catch (e) {
        logLine(`[annotation] agent delivery failed, falling back to the queue: ${String(e)}`)
      }
    }
    mirror.addInjection(d.text, 'annotation')
    mirror.add({
      kind: 'annotation',
      annotationId: d.annotationId,
      text: d.text,
      question: d.question,
      tool: d.tool,
      url: d.url,
      summary: d.summary,
      elementCount: d.elementCount,
      ...(currentPanelMode === 'agent' ? { source: 'agent' as const } : {})
    })
  }
  const annotationSubmit = createAnnotationSubmitHandler(tabs!, mirror, deliverAnnotation)
  annotationSubmitHandler = async (payload) => {
    if (isAiPaused()) {
      return { ok: false, error: 'AI 已急停挂起：请先点「恢复」再提交标注' }
    }
    if (currentPanelMode === 'external') {
      return { ok: false, error: '外部工具模式下标注不会送达：请切换到内置模型或 opencode 模式' }
    }
    return annotationSubmit(payload)
  }

  try {
    writeEndpoint({
      port: httpServer.port,
      token: TOKEN,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: VERSION
    })
  } catch (e) {
    logLine(`[duplex] failed to write endpoint file: ${String(e)}`)
  }
  logLine(`[duplex] ready on 127.0.0.1:${httpServer.port} (pid ${process.pid})`)

  if (process.env['COBROWSE_DEBUG_UI'] === '1') {
    setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const img = await win?.webContents.capturePage()
          if (img) {
            fs.writeFileSync(path.join(cobrowseDir(), 'ui-snapshot.png'), img.toPNG())
            logLine('[debug] ui snapshot written')
          }
        } catch (e) {
          logLine(`[debug] ui snapshot failed: ${String(e)}`)
        }
      })()
    }, 6000)
  }
}

/** Windows 11 (build >= 22000) supports system-drawn acrylic material. */
function supportsAcrylic(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const parts = os.release().split('.')
    return Number(parts[2] ?? 0) >= 22000
  } catch {
    return false
  }
}

/** Keep the native window background in sync with the theme (no-op under acrylic). */
function applyWindowBackground(): void {
  if (!win || acrylicWindow) return
  try {
    win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0f1216' : '#eef1f5')
  } catch {
    /* ignore */
  }
}

function createWindow(): void {
  const acrylic = supportsAcrylic()
  acrylicWindow = acrylic
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Duplex',
    backgroundColor: acrylic ? '#00000000' : '#0f1216',
    ...(acrylic ? { backgroundMaterial: 'acrylic' as const } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'out', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => {
    win?.show()
    win?.focus()
  })

  win.on('closed', () => {
    // macOS keeps the app resident after the window closes; drop the window and
    // its tab manager so a later `activate` can rebuild both cleanly.
    const oldTabs = tabs
    win = null
    tabs = null
    oldTabs?.destroy()
  })

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      // packaged builds keep devtools out; only dev/测试 builds may open them
      if (!app.isPackaged) {
        win?.webContents.toggleDevTools()
        e.preventDefault()
      }
    }
  })

  win.webContents.on('console-message', (...args: unknown[]) => {
    const a0 = args[0] as Record<string, unknown> | undefined
    const msg = (a0?.message ?? args[2] ?? '') as string
    const lvl = (a0?.level ?? args[1] ?? '') as string
    logLine(`[renderer:${lvl}] ${msg}`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logLine(`[renderer:did-fail-load] ${code} ${desc} ${url}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    logLine(`[renderer:gone] ${JSON.stringify(details)}`)
  })
  win.on('unresponsive', () => logLine('[window] unresponsive'))
  win.on('responsive', () => logLine('[window] responsive again'))

  const appRoot = app.getAppPath()
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(appRoot, 'out', 'renderer', 'index.html'))
  }

  tabs = new TabManager(
    win,
    path.join(app.getAppPath(), 'out', 'preload', 'overlay.cjs'),
    () => {
      try {
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
        win.webContents.send('tabs:update', tabs!.list(), tabs!.activeId)
        const list = tabs!.list()
        // drop annotation state for tabs that are gone
        if (annotationTabState.size > 0) {
          const alive = new Set(list.map((t) => t.id))
          for (const id of [...annotationTabState.keys()]) {
            if (!alive.has(id)) annotationTabState.delete(id)
          }
        }
        // keep the renderer's annotation toggle in sync when switching tabs
        if (tabs!.activeId !== lastActiveTabId) {
          lastActiveTabId = tabs!.activeId
          sendAnnotationState(
            lastActiveTabId != null ? (annotationTabState.get(lastActiveTabId) ?? false) : false
          )
        }
      } catch {
        /* window is going away */
      }
    },
    (url, title, favicon) => {
      if (/^https?:\/\//i.test(url)) browserData.addHistory({ url, title, favicon, visitedAt: Date.now() })
      emitBrowserData()
    },
    (action) => {
      if (action === 'newTab' || action === 'reopenClosed' || action === 'nextTab' || action === 'previousTab') {
        if (action === 'nextTab' || action === 'previousTab') {
          const all = tabs?.list() ?? []
          const index = all.findIndex((t) => t.id === tabs?.activeId)
          const next = all[(index + (action === 'nextTab' ? 1 : -1) + all.length) % all.length]
          if (next) tabs?.setActive(next.id)
        } else if (action === 'newTab') tabs?.createTab()
        else tabs?.reopenClosed()
      } else win?.webContents.send('browser:shortcut', action)
    },
    (url, title, favicon) => { browserData.updateLatestHistory(url, title, favicon); emitBrowserData() },
    (info) => {
      try {
        win?.webContents.send('browser:load-error', info)
      } catch {
        /* window is going away */
      }
    },
    (result) => {
      try {
        win?.webContents.send('browser:find-result', result)
      } catch {
        /* window is going away */
      }
    },
    (tab, info) => showPageContextMenu(tab, info)
  )
  tabs.createTab()
  tabs.setShortcuts(effectiveShortcuts(loadSettings().shortcuts))

  mirror.onEvent = (ev) => {
    try {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send('mirror:event', ev)
    } catch {
      /* window is going away */
    }
  }

  applyWindowBackground()
}

/** Toggle annotation mode for the active tab (shared by IPC and the tools menu). */
function toggleAnnotationMode(): { ok: boolean; active: boolean } {
  const tab = tabs?.getActive()
  if (!tab) return { ok: false, active: false }
  const next = !(annotationTabState.get(tab.id) ?? false)
  annotationTabState.set(tab.id, next)
  overlaySend(tab, { kind: 'annotationMode', active: next })
  return { ok: true, active: next }
}

/** Persist + apply a theme setting (shared by IPC and the tools menu). */
function applyThemeSetting(theme: ThemeSetting): { ok: boolean; error?: string } {
  const saved = saveTheme(theme)
  if (!saved.ok) return { ok: false, error: saved.error ?? '设置保存失败' }
  nativeTheme.themeSource = theme
  applyWindowBackground()
  logLine(`[theme] set to ${theme}`)
  return { ok: true }
}

/** Validate + persist a search engine (shared by IPC and the engine menu). */
function applySearchEngine(engine: string): { ok: boolean; error?: string } {
  if (typeof engine !== 'string' || !(engine in SEARCH_ENGINES)) {
    return { ok: false, error: '未知搜索引擎' }
  }
  const saved = saveSearchEngine(engine as SearchEngine)
  if (!saved.ok) return { ok: false, error: saved.error ?? '设置保存失败' }
  return { ok: true }
}

/**
 * Imported OAuth credentials must not be sent to unlisted hosts unless the
 * gateway was explicitly trusted (same gate as the runtime auth-import check).
 */
function providerTrustError(
  authType: string,
  authSource: string | undefined,
  baseUrl: string,
  allowCustomHost: boolean | undefined
): string | null {
  if (authType !== 'import') return null
  if (allowCustomHost === true) return null
  if (isTrustedImportedHost(baseUrl, authSource)) return null
  return '该地址不在官方白名单；如确认信任此网关请勾选「我信任此网关」，或改用官方地址'
}

const THEME_LABELS: Record<ThemeSetting, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色'
}

/** Push a browser shortcut action to the renderer (native menu entry points). */
function sendBrowserShortcut(action: string): void {
  try {
    win?.webContents.send('browser:shortcut', action)
  } catch {
    /* window is going away */
  }
}

/** Native popup via Menu.popup — rendered by the OS, never blanks the page view. */
function popupAppMenu(template: MenuItemConstructorOptions[], x: number, y: number): void {
  if (!win || win.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y)) return
  try {
    const menu = Menu.buildFromTemplate(template)
    menu.popup({ window: win, x: Math.round(x), y: Math.round(y) })
  } catch (e) {
    logLine(`[menu] popup failed: ${(e as Error)?.message ?? String(e)}`)
  }
}

/** Single-line menu label, truncated with an ellipsis when too long. */
function truncateMenuLabel(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** WebContents of the active page tab, or null when there is none/already gone. */
function activePageWebContents(): WebContents | null {
  try {
    const tab = tabs?.getActive()
    if (!tab) return null
    const wc = tab.view.webContents
    return wc.isDestroyed() ? null : wc
  } catch {
    return null
  }
}

/** Copy `[title](url)` of the given page to the clipboard and notify the renderer. */
function copyPageAsMarkdown(wc: WebContents | null | undefined): void {
  if (!wc || wc.isDestroyed()) return
  try {
    const url = wc.getURL()
    if (!url || url === 'about:blank') return
    const title = wc.getTitle() || url
    clipboard.writeText(`[${title}](${url})`)
    sendBrowserShortcut('menu:copied-markdown')
  } catch (e) {
    logLine(`[menu] copy markdown failed: ${(e as Error)?.message ?? String(e)}`)
  }
}

/** Add every http(s) tab to a freshly named bookmark folder. */
function bookmarkAllTabs(): void {
  if (!tabs) return
  const items = tabs.list().filter((t) => /^https?:\/\//i.test(t.url))
  if (items.length === 0) return
  const pad = (n: number): string => String(n).padStart(2, '0')
  const now = new Date()
  const folder = `标签组 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  browserData.addFolder(folder) // already existing (same minute) is fine
  for (const item of items) {
    browserData.addBookmark({
      url: item.url,
      title: item.title || item.url,
      favicon: item.favicon,
      folder
    })
  }
  emitBrowserData()
  sendBrowserShortcut(`menu:bookmarked-all:${items.length}`)
}

/**
 * Native menu for a right-click on page content. Sections are built from the
 * click context (link / image / selection / editable) and share a common tail.
 */
function showPageContextMenu(tab: Tab, info: PageContextMenuInfo): void {
  const template: MenuItemConstructorOptions[] = []
  const copyText = (text: string, action: string): void => {
    try {
      clipboard.writeText(text)
      sendBrowserShortcut(action)
    } catch (e) {
      logLine(`[menu] clipboard write failed: ${(e as Error)?.message ?? String(e)}`)
    }
  }
  if (info.linkURL) {
    template.push(
      { label: '在新标签页打开链接', click: () => tabs?.createTab(info.linkURL) },
      { label: '复制链接地址', click: () => copyText(info.linkURL, 'menu:copied-link') },
      { type: 'separator' }
    )
  }
  if (info.mediaType === 'image' && info.srcURL) {
    const srcURL = info.srcURL
    template.push(
      { label: '在新标签页打开图片', click: () => tabs?.createTab(srcURL) },
      { label: '复制图片地址', click: () => copyText(srcURL, 'menu:copied-image') },
      {
        label: '图片另存为',
        click: () => {
          try {
            const wc = tab.view.webContents
            if (!wc.isDestroyed()) wc.downloadURL(srcURL)
          } catch {
            /* page already gone */
          }
        }
      },
      { type: 'separator' }
    )
  }
  if (info.selectionText) {
    const selectionText = info.selectionText
    const engine = loadSettings().searchEngine
    const engineName = SEARCH_ENGINES[engine]?.name ?? SEARCH_ENGINES.baidu.name
    template.push(
      { label: '复制', role: 'copy' },
      {
        label: `使用${engineName}搜索 "${truncateMenuLabel(selectionText, 30)}"`,
        click: () => tabs?.createTab(searchUrl(selectionText, engine))
      },
      { type: 'separator' }
    )
  }
  if (info.isEditable) {
    template.push(
      { label: '剪切', role: 'cut', enabled: info.editFlags.canCut },
      { label: '复制', role: 'copy', enabled: info.editFlags.canCopy },
      { label: '粘贴', role: 'paste', enabled: info.editFlags.canPaste },
      { label: '全选', role: 'selectAll', enabled: info.editFlags.canSelectAll },
      { type: 'separator' }
    )
  }
  // common tail: navigation of the page the menu belongs to (the active one,
  // since only visible views can receive a right-click)
  const targetTab = tabs?.getActive() ?? tab
  const wcAtClick = (): WebContents | null => {
    try {
      const wc = targetTab.view.webContents
      return wc.isDestroyed() ? null : wc
    } catch {
      return null
    }
  }
  let canGoBack = false
  let canGoForward = false
  let pageUrl = ''
  try {
    const wc = wcAtClick()
    if (wc) {
      canGoBack = wc.navigationHistory.canGoBack()
      canGoForward = wc.navigationHistory.canGoForward()
      pageUrl = wc.getURL()
    }
  } catch {
    /* page already gone */
  }
  template.push(
    {
      label: '后退',
      enabled: canGoBack,
      click: () => {
        const wc = wcAtClick()
        if (!wc) return
        const nav = wc.navigationHistory
        if (nav.canGoBack()) nav.goBack()
      }
    },
    {
      label: '前进',
      enabled: canGoForward,
      click: () => {
        const wc = wcAtClick()
        if (!wc) return
        const nav = wc.navigationHistory
        if (nav.canGoForward()) nav.goForward()
      }
    },
    {
      label: '刷新',
      enabled: pageUrl !== '',
      click: () => {
        const wc = wcAtClick()
        if (wc) wc.reload()
      }
    },
    { type: 'separator' },
    { label: '复制页面地址', enabled: pageUrl !== '', click: () => copyText(pageUrl, 'menu:copied-url') },
    { label: '复制为 Markdown', enabled: pageUrl !== '', click: () => copyPageAsMarkdown(wcAtClick()) }
  )
  popupAppMenu(template, info.x, info.y)
}

function setupIpc(): void {
  ipcMain.handle('ui:ready', () => {
    const state = {
      tabs: tabs?.list() ?? [],
      activeTabId: tabs?.activeId ?? null,
      mirror: mirror.snapshot()
    }
    // The renderer registers its state listeners right after calling ready();
    // push the latched main-process state once its effects have run.
    setTimeout(() => {
      try {
        win?.webContents.send('emergency:state', { paused: isAiPaused() })
        win?.webContents.send(
          'annotation:state',
          tabs?.activeId != null ? (annotationTabState.get(tabs.activeId) ?? false) : false
        )
      } catch {
        /* window is going away */
      }
    }, 400)
    return state
  })

  ipcMain.handle('browser:data', () => browserData.snapshot())
  ipcMain.handle('browser:bookmark-toggle', (_e, record: { url: string; title: string; favicon?: string }) => {
    const bookmarked = browserData.toggleBookmark(record)
    emitBrowserData()
    return { bookmarked }
  })
  ipcMain.handle(
    'browser:bookmark-add',
    (_e, record: { url: string; title: string; favicon?: string; folder?: string }) => {
      const result = browserData.addBookmark(record)
      if (result.ok) emitBrowserData()
      return result
    }
  )
  ipcMain.handle(
    'browser:bookmark-update',
    (_e, url: string, patch: { title?: string; url?: string; folder?: string }) => {
      const result = browserData.updateBookmark(url, patch)
      if (result.ok) emitBrowserData()
      return result
    }
  )
  ipcMain.handle('browser:bookmark-remove', (_e, url: string) => {
    browserData.removeBookmark(url)
    emitBrowserData()
    return { ok: true }
  })
  ipcMain.handle('browser:bookmark-folder-add', (_e, name: string) => {
    const result = browserData.addFolder(name)
    if (result.ok) emitBrowserData()
    return result
  })
  ipcMain.handle('browser:bookmark-folder-remove', (_e, name: string) => {
    browserData.removeFolder(name)
    emitBrowserData()
    return { ok: true }
  })
  ipcMain.handle('browser:bookmark-folder-rename', (_e, oldName: string, newName: string) => {
    const result = browserData.renameFolder(oldName, newName)
    if (result.ok) emitBrowserData()
    return result
  })
  ipcMain.handle('browser:history-remove', (_e, url: string, visitedAt: number) => {
    browserData.removeHistory(url, visitedAt)
    emitBrowserData()
    return { ok: true }
  })
  ipcMain.handle('browser:history-clear', () => { browserData.clearHistory(); emitBrowserData(); return { ok: true } })
  ipcMain.handle('downloads:list', () => downloads.list())
  ipcMain.handle('downloads:cancel', (_e, id: string) => ({ ok: downloads.cancel(id) }))
  ipcMain.handle('downloads:clear', () => { downloads.clear(); return { ok: true } })
  ipcMain.handle('downloads:open', (_e, id: string) => downloads.open(id))
  ipcMain.handle('downloads:reveal', (_e, id: string) => downloads.reveal(id))
  ipcMain.handle('downloads:confirm-get', () => ({ enabled: loadSettings().confirmBeforeDownload }))
  ipcMain.handle('downloads:confirm-set', (_e, enabled: boolean) => {
    const saved = saveConfirmBeforeDownload(enabled === true)
    if (!saved.ok) return { ok: false, error: saved.error ?? '设置保存失败' }
    return { ok: true }
  })

  ipcMain.on('ui:bounds', (_e, bounds: ContentBounds) => {
    tabs?.updateBounds(bounds)
  })

  ipcMain.on('browser:chrome-overlay', (_e, id: string, open: boolean) => {
    tabs?.setChromeOverlay(id, open === true)
  })

  ipcMain.handle(
    'tabs:action',
    (_e, action: { type: string; url?: string; tabId?: number; value?: number }) => {
      if (!tabs) return { ok: false }
      const noTab = { ok: false, error: '没有打开的标签页' }
      try {
        switch (action.type) {
          case 'navigate':
          case 'search': {
            // 地址栏/搜索在零标签时也应有去路：先建一个标签页再执行
            const tab = tabs.getActive() ?? tabs.createTab()
            if (action.url) {
              let url: string
              if (action.type === 'search') {
                url = searchUrl(action.url, loadSettings().searchEngine)
              } else {
                const addr = resolveAddress(action.url)
                url =
                  addr.kind === 'url' ? addr.url : searchUrl(addr.query, loadSettings().searchEngine)
              }
              void tab.view.webContents.loadURL(url)
            }
            break
          }
          case 'back': {
            const tab = tabs.getActive()
            if (!tab) return noTab
            const nav = tab.view.webContents.navigationHistory
            if (nav.canGoBack()) nav.goBack()
            break
          }
          case 'forward': {
            const tab = tabs.getActive()
            if (!tab) return noTab
            const nav = tab.view.webContents.navigationHistory
            if (nav.canGoForward()) nav.goForward()
            break
          }
          case 'reload': {
            const tab = tabs.getActive()
            if (!tab) return noTab
            tab.view.webContents.reload()
            break
          }
          case 'newTab': {
            let url: string | undefined
            if (action.url) {
              const addr = resolveAddress(action.url)
              url =
                addr.kind === 'url' ? addr.url : searchUrl(addr.query, loadSettings().searchEngine)
            }
            tabs.createTab(url)
            break
          }
          case 'closeTab':
            if (action.tabId != null) tabs.closeTab(action.tabId)
            break
          case 'switchTab':
            if (action.tabId != null) tabs.setActive(action.tabId)
            break
          case 'reopenClosed':
            tabs.reopenClosed()
            break
          case 'duplicateTab':
            if (action.tabId != null) tabs.duplicateTab(action.tabId)
            break
          case 'closeOthers':
            if (action.tabId != null) tabs.closeOthers(action.tabId)
            break
          case 'closeToRight':
            if (action.tabId != null) tabs.closeToRight(action.tabId)
            break
          case 'toggleMute': {
            if (action.tabId == null) return noTab
            if (!tabs.toggleMute(action.tabId)) return { ok: false, error: '标签页不存在' }
            break
          }
          case 'find': {
            const tab = tabs.getActive()
            if (!tab) return noTab
            if (action.url) tab.view.webContents.findInPage(action.url)
            else tab.view.webContents.stopFindInPage('clearSelection')
            break
          }
          case 'findNext':
          case 'findPrev': {
            const tab = tabs.getActive()
            if (!tab) return noTab
            if (action.url) {
              tab.view.webContents.findInPage(action.url, {
                forward: action.type === 'findNext',
                findNext: true
              })
            }
            break
          }
          case 'stopLoad': {
            const tab = tabs.getActive()
            if (!tab) return noTab
            tab.view.webContents.stop()
            break
          }
          case 'zoom': {
            const tab = tabs.getActive()
            if (!tab) return noTab
            const wc = tab.view.webContents
            const delta =
              typeof action.value === 'number' && Number.isFinite(action.value) ? action.value : 0
            const next = delta === 0 ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta))
            wc.setZoomLevel(next)
            break
          }
          case 'annotationMode': {
            const tab = tabs.getActive()
            if (!tab) return noTab
            tab.view.webContents.send('overlay:cmd', { kind: 'annotationMode' })
            break
          }
          default:
            return { ok: false, error: `unknown action ${action.type}` }
        }
      } catch (e) {
        return { ok: false, error: (e as Error)?.message ?? String(e) }
      }
      return { ok: true }
    }
  )

  // ---------- native menus (OS-rendered, so the page view is never covered) ----------
  ipcMain.on('tabs:context-menu', (_e, tabId: number, x: number, y: number) => {
    if (!tabs) return
    const id = Number(tabId)
    if (!Number.isFinite(id)) return
    const infos = tabs.list()
    const index = infos.findIndex((t) => t.id === id)
    const tab = tabs.getTab(id)
    const info = infos.find((t) => t.id === id)
    const closed = tabs.getClosedTabs()
    const recentClosed: MenuItemConstructorOptions[] =
      closed.length > 0
        ? [...closed].reverse().map((entry, i) => {
            const full = entry.title || entry.url
            return {
              label: truncateMenuLabel(full, 40),
              toolTip: full,
              click: () => tabs?.reopenClosed(closed.length - 1 - i)
            }
          })
        : [{ label: '(空)', enabled: false }]
    popupAppMenu(
      [
        { label: '复制标签页', enabled: tab != null, click: () => tabs?.duplicateTab(id) },
        {
          label: info?.audioMuted ? '取消静音' : '静音标签页',
          enabled: tab != null,
          click: () => tabs?.toggleMute(id)
        },
        {
          label: '关闭其他标签页',
          enabled: tab != null && infos.length > 1,
          click: () => tabs?.closeOthers(id)
        },
        {
          label: '关闭右侧标签页',
          enabled: tab != null && index >= 0 && index < infos.length - 1,
          click: () => tabs?.closeToRight(id)
        },
        {
          label: '所有标签页加入书签',
          enabled: infos.some((t) => /^https?:\/\//i.test(t.url)),
          click: () => bookmarkAllTabs()
        },
        { type: 'separator' },
        { label: '最近关闭的标签页', submenu: recentClosed },
        {
          label: '重新打开关闭的标签页',
          enabled: tabs.canReopenClosed(),
          click: () => tabs?.reopenClosed()
        }
      ],
      Number(x),
      Number(y)
    )
  })

  ipcMain.on('search:engine-menu', (_e, x: number, y: number) => {
    const current = loadSettings().searchEngine
    const template: MenuItemConstructorOptions[] = Object.entries(SEARCH_ENGINES).map(
      ([key, engine]) => ({
        label: engine.name,
        type: 'radio',
        checked: key === current,
        click: () => {
          const r = applySearchEngine(key)
          if (!r.ok) {
            logLine(`[search] engine save failed: ${r.error ?? ''}`)
            return
          }
          try {
            win?.webContents.send('search:engine-changed', key)
          } catch {
            /* window is going away */
          }
        }
      })
    )
    popupAppMenu(template, Number(x), Number(y))
  })

  ipcMain.on(
    'tools:menu',
    (_e, x: number, y: number, state: { annotationActive?: boolean; theme?: string }) => {
      const theme: ThemeSetting =
        state?.theme === 'light' || state?.theme === 'dark' || state?.theme === 'system'
          ? state.theme
          : loadSettings().theme
      const annotationActive =
        tabs?.activeId != null
          ? (annotationTabState.get(tabs.activeId) ?? false)
          : state?.annotationActive === true
      const template: MenuItemConstructorOptions[] = [
        { label: '书签', click: () => sendBrowserShortcut('menu:library-bookmarks') },
        { label: '浏览记录', click: () => sendBrowserShortcut('menu:library-history') },
        { label: '下载内容', click: () => sendBrowserShortcut('menu:library-downloads') },
        { label: '复制本页为 Markdown', click: () => copyPageAsMarkdown(activePageWebContents()) },
        { type: 'separator' },
        {
          label: '页面标注',
          type: 'checkbox',
          checked: annotationActive,
          click: () => sendAnnotationState(toggleAnnotationMode().active)
        },
        { label: '设置急停键', click: () => sendBrowserShortcut('menu:stopkeys') },
        { label: '快捷键设置', click: () => sendBrowserShortcut('menu:shortcuts') },
        { type: 'separator' },
        ...(['system', 'light', 'dark'] as const).map(
          (t): MenuItemConstructorOptions => ({
            label: THEME_LABELS[t],
            type: 'radio',
            checked: theme === t,
            click: () => {
              const r = applyThemeSetting(t)
              if (!r.ok) {
                logLine(`[theme] save failed: ${r.error ?? ''}`)
                return
              }
              try {
                win?.webContents.send('theme:changed', t)
              } catch {
                /* window is going away */
              }
            }
          })
        ),
        {
          label: '下载前询问保存位置',
          type: 'checkbox',
          checked: loadSettings().confirmBeforeDownload,
          click: (item) => {
            const r = saveConfirmBeforeDownload(item.checked)
            if (!r.ok) logLine(`[downloads] confirm-before-download save failed: ${r.error ?? ''}`)
          }
        }
      ]
      popupAppMenu(template, Number(x), Number(y))
    }
  )

  // The renderer tells us which panel is visible — annotations are routed to
  // the built-in agent only when that panel is the active one.
  ipcMain.handle('ui:panel-mode', (_e, mode: string) => {
    currentPanelMode = mode === 'opencode' || mode === 'external' ? mode : 'agent'
    return { ok: true }
  })

  // Toggle annotation mode for the active tab (state is mirrored per tab and
  // echoed back through `annotation:state` when the overlay confirms).
  ipcMain.handle('annotation:toggle', () => toggleAnnotationMode())

  ipcMain.on(
    'overlay:event',
    (
      _e,
      ev: {
        kind?: string
        via?: string
        annotationId?: string
        active?: boolean
        question?: string
      }
    ) => {
      if (ev?.kind === 'ready') {
        try {
          _e.sender.send('overlay:cmd', {
            kind: 'hotkeys',
            keys: loadSettings().emergencyStopKeys
          })
        } catch {
          /* frame is going away */
        }
        return
      }
      if (ev?.kind === 'takeover') {
        const aborted = abortOperation()
        agentRuntime?.abortForEmergency()
        const killed = stopExternalChildren()
        const confirms = denyAllPendingConfirms()
        const dropped = mirror.clearInjections()
        const newly = pauseAi()
        if (newly) saveAiPaused(true)
        hideAllVisuals(tabs?.getActive() ?? null)
        try {
          win?.webContents.send('emergency:stop', {
            via: ev.via ?? 'unknown',
            aborted,
            killed,
            dropped
          })
          win?.webContents.send('emergency:state', { paused: true })
          win?.webContents.send('agent:confirm-cancel', {})
        } catch {
          /* window is going away */
        }
        logLine(
          `[takeover] via ${ev.via ?? 'unknown'} (aborted=${aborted}, killed=${killed}, confirms=${confirms}, sends-dropped=${dropped}, newly-paused=${newly})`
        )
        return
      }
      if (ev?.kind === 'annotationState') {
        const active = ev.active === true
        const senderTabId = findTabIdBySender(_e.sender)
        const tabId = senderTabId ?? tabs?.activeId ?? null
        if (tabId != null) annotationTabState.set(tabId, active)
        // only mirror the active tab's state into the chrome UI
        if (tabId == null || tabId === tabs?.activeId) sendAnnotationState(active)
        return
      }
      if (ev?.kind === 'annotationSubmit') {
        if (!annotationSubmitHandler) return
        const annotationId = String(ev.annotationId ?? '')
        const replyResult = (ok: boolean, error?: string, warning?: string): void => {
          // reply to the tab that submitted (not whichever tab is active now)
          const senderTabId = findTabIdBySender(_e.sender)
          const tab =
            (senderTabId != null ? tabs?.getTab(senderTabId) : undefined) ?? tabs?.getActive()
          if (!tab) return
          const elementCount = annotationElementCounts.get(annotationId)
          annotationElementCounts.delete(annotationId)
          overlaySend(tab, {
            kind: 'annotationResult',
            annotationId,
            ok,
            ...(error ? { error } : {}),
            ...(warning ? { warning } : {}),
            ...(elementCount != null ? { elementCount } : {})
          })
        }
        try {
          void annotationSubmitHandler(ev as unknown as AnnotationSubmitPayload).then(
            (r) => {
              logLine(
                `[annotation] submit ${annotationId || '?'} -> ${r.ok ? 'queued' : 'error: ' + (r.error ?? '')}`
              )
              let warning: string | undefined
              if (r.ok) {
                if (currentPanelMode === 'opencode' && !mirror.hasConsumer()) {
                  warning = 'opencode 未连接：标注已排队，连接后自动送达'
                } else if (currentPanelMode === 'agent' && !(ev.question ?? '').trim()) {
                  warning = '已记录标注（未提问：AI 不会单独回应）'
                }
              }
              replyResult(r.ok, r.error, warning)
            },
            (err) => {
              const message = (err as Error)?.message ?? String(err)
              logLine(`[annotation] submit ${annotationId || '?'} -> rejected: ${message}`)
              replyResult(false, message)
            }
          )
        } catch (err) {
          const message = (err as Error)?.message ?? String(err)
          logLine(`[annotation] submit ${annotationId || '?'} -> threw: ${message}`)
          replyResult(false, message)
        }
        return
      }
      if (ev?.kind === 'annotationDismiss') {
        logLine(`[annotation] dismissed ${ev.annotationId ?? '?'}`)
      }
    }
  )

  ipcMain.handle('chat:send', (_e, text: string): ChatSendResult => {
    const t = String(text ?? '').trim()
    if (!t) return { ok: false }
    maybeResumeAi()
    const inj = mirror.addInjection(t, 'panel')
    if (!mirror.hasConsumer()) {
      return {
        ok: true,
        id: inj.id,
        warning: 'opencode 未连接：消息已排队，连接后自动送达'
      }
    }
    return { ok: true, id: inj.id }
  })

  ipcMain.handle('theme:get', () => ({ theme: loadSettings().theme }))

  ipcMain.handle(
    'session:command',
    (_e, cmd: { action?: string; sessionID?: string | null; title?: string }) => {
      const action = cmd?.action
      if (action !== 'list' && action !== 'select' && action !== 'create') {
        return { ok: false, error: 'bad action' }
      }
      if (action === 'select') {
        // authoritative state change — every plugin instance reads it via
        // /api/session/state, so no command broadcast is needed
        sessionBus.select({ sessionID: cmd.sessionID ?? null, title: cmd.title })
        mirror.add({
          kind: 'session-info',
          activeSessionID: sessionBus.state.activeSessionID,
          activeTitle: sessionBus.state.activeTitle ?? undefined,
          reason: sessionBus.state.activeSessionID ? 'selected' : 'auto'
        })
        let saved: { ok: boolean; error?: string }
        if (sessionBus.state.activeSessionID) {
          // ask some plugin instance to push the session's history so the
          // panel shows the context of the session we just switched to
          sessionBus.push({ action: 'history', sessionID: sessionBus.state.activeSessionID })
          saved = saveSession({
            id: sessionBus.state.activeSessionID,
            title: sessionBus.state.activeTitle ?? ''
          })
        } else {
          saved = saveSession(null)
        }
        if (!saved.ok) return { ok: false, error: saved.error ?? '设置保存失败' }
        return { ok: true }
      }
      sessionBus.push({
        action,
        sessionID: cmd.sessionID ?? null,
        title: cmd.title
      })
      return { ok: true }
    }
  )

  ipcMain.handle('session:state', () => sessionBus.state)

  ipcMain.handle('theme:set', (_e, theme: string) => {
    const t: ThemeSetting = theme === 'light' || theme === 'dark' ? theme : 'system'
    const r = applyThemeSetting(t)
    if (!r.ok) return r
    return { ok: true, theme: t }
  })

  ipcMain.handle('agent:send', async (_e, text: string) => {
    if (!agentRuntime) return { ok: false, error: 'agent not ready' }
    if (!activeAgentConfig()) {
      return { ok: false, error: '当前模型配置不存在，请在 ⚙ 模型配置里选择或新建' }
    }
    maybeResumeAi()
    try {
      return await agentRuntime.send(String(text ?? ''))
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) }
    }
  })

  ipcMain.on('emergency:resume', () => {
    if (resumeAi()) {
      saveAiPaused(false)
      try {
        win?.webContents.send('emergency:state', { paused: false })
      } catch {
        /* window is going away */
      }
      logLine('[takeover] AI resumed via window control')
    }
  })

  ipcMain.handle('agent:abort', () => {
    agentRuntime?.abort()
    return { ok: true }
  })

  ipcMain.handle('agent:reset', () => {
    agentRuntime?.reset()
    return { ok: true }
  })

  ipcMain.handle('agent:new-session', () => agentRuntime?.newSession() ?? { ok: false })

  ipcMain.handle('agent:sessions', () => agentRuntime?.listSessions() ?? [])

  ipcMain.handle('agent:switch-session', (_e, id: string) =>
    agentRuntime?.switchSession(String(id)) ?? { ok: false }
  )

  ipcMain.handle('agent:delete-session', (_e, id: string) =>
    agentRuntime?.deleteSession(String(id)) ?? { ok: false }
  )

  ipcMain.handle('agent:events', () => agentRuntime?.events() ?? [])

  ipcMain.handle('agent:providers', () => {
    const s = loadSettings()
    return {
      providers: maskProviders(s.agentProviders),
      activeId: s.activeProviderId
    }
  })

  ipcMain.handle(
    'agent:provider-save',
    (
      _e,
      input: {
        id?: string
        name?: string
        baseUrl?: string
        apiKey?: string
        model?: string
        protocol?: string
        authType?: string
        authSource?: string
        allowCustomHost?: boolean
        idleTimeoutMs?: number
        clearApiKey?: boolean
      }
    ) => {
      const s = loadSettings()
      // Explicit key clearing (the renderer sends only {id, clearApiKey}):
      // an empty apiKey alone means "keep the stored key", so this dedicated
      // path is what makes clearing possible at all.
      if (input?.clearApiKey === true) {
        const idx = input?.id ? s.agentProviders.findIndex((p) => p.id === input.id) : -1
        if (idx < 0) return { ok: false, error: '未找到该模型配置' }
        const list = s.agentProviders.slice()
        list[idx] = { ...list[idx], apiKey: '' }
        const saved = saveProviders(list, s.activeProviderId)
        if (!saved.ok) return { ok: false, error: saved.error ?? '设置保存失败' }
        logLine(`[agent] provider key cleared: ${list[idx].name}`)
        return { ok: true }
      }
      const baseUrl = String(input?.baseUrl ?? '').trim()
      if (!baseUrl) return { ok: false, error: 'Base URL 不能为空' }
      const list = s.agentProviders.slice()
      const idx = input?.id ? list.findIndex((p) => p.id === input.id) : -1
      const apiKeyInput = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
      const allowCustomHost =
        typeof input?.allowCustomHost === 'boolean' ? input.allowCustomHost : undefined
      const idleTimeoutMs =
        typeof input?.idleTimeoutMs === 'number' &&
        Number.isFinite(input.idleTimeoutMs) &&
        input.idleTimeoutMs >= 0
          ? Math.floor(input.idleTimeoutMs)
          : undefined
      if (idx >= 0) {
        const prev = list[idx]
        const nextAuthType =
          input?.authType === 'import' ? 'import' : input?.authType === 'key' ? 'key' : prev.authType
        const nextAuthSource =
          input?.authSource === 'codex' || input?.authSource === 'opencode'
            ? input.authSource
            : input?.authType === 'key'
              ? undefined
              : prev.authSource
        const nextAllowCustomHost =
          typeof input?.allowCustomHost === 'boolean' ? input.allowCustomHost : prev.allowCustomHost
        const trustError = providerTrustError(
          nextAuthType,
          nextAuthSource,
          baseUrl,
          nextAllowCustomHost
        )
        if (trustError) return { ok: false, error: trustError }
        list[idx] = {
          ...prev,
          name: String(input?.name ?? '').trim() || prev.name || deriveName(baseUrl),
          baseUrl,
          model: String(input?.model ?? '').trim(),
          apiKey: apiKeyInput || prev.apiKey,
          protocol: isLlmProtocol(input?.protocol) ? input.protocol : prev.protocol,
          authType: nextAuthType,
          authSource: nextAuthSource,
          allowCustomHost: nextAllowCustomHost,
          idleTimeoutMs:
            typeof input?.idleTimeoutMs === 'number' &&
            Number.isFinite(input.idleTimeoutMs) &&
            input.idleTimeoutMs >= 0
              ? Math.floor(input.idleTimeoutMs)
              : prev.idleTimeoutMs
        }
        const saved = saveProviders(list, s.activeProviderId)
        if (!saved.ok) return { ok: false, error: saved.error ?? '设置保存失败' }
        logLine(`[agent] provider updated: ${deriveName(baseUrl)}`)
        return { ok: true }
      }
      const authType: 'key' | 'import' = input?.authType === 'import' ? 'import' : 'key'
      const authSource =
        input?.authSource === 'codex' || input?.authSource === 'opencode'
          ? input.authSource
          : undefined
      const trustError = providerTrustError(authType, authSource, baseUrl, allowCustomHost)
      if (trustError) return { ok: false, error: trustError }
      const id = newProviderId()
      list.push({
        id,
        name: String(input?.name ?? '').trim() || deriveName(baseUrl),
        baseUrl,
        model: String(input?.model ?? '').trim(),
        apiKey: apiKeyInput,
        protocol: isLlmProtocol(input?.protocol) ? input.protocol : 'openai-chat',
        authType,
        authSource,
        allowCustomHost,
        idleTimeoutMs
      })
      const active = s.activeProviderId ?? id
      const saved = saveProviders(list, active)
      if (!saved.ok) return { ok: false, error: saved.error ?? '设置保存失败' }
      logLine(`[agent] provider added: ${deriveName(baseUrl)} (active=${active === id})`)
      return { ok: true, id }
    }
  )

  ipcMain.handle('agent:provider-remove', (_e, id: string) => {
    const s = loadSettings()
    const list = s.agentProviders.filter((p) => p.id !== id)
    const active = s.activeProviderId === id ? (list[0]?.id ?? null) : s.activeProviderId
    const saved = saveProviders(list, active)
    if (!saved.ok) return { ok: false, error: saved.error ?? '设置保存失败' }
    logLine(`[agent] provider removed: ${String(id)}`)
    return { ok: true }
  })

  ipcMain.handle('agent:provider-activate', (_e, id: string) => {
    const s = loadSettings()
    const target = s.agentProviders.find((p) => p.id === id)
    if (!target) return { ok: false, error: 'provider not found' }
    const saved = saveProviders(s.agentProviders, id)
    if (!saved.ok) return { ok: false, error: saved.error ?? '设置保存失败' }
    logLine(`[agent] provider activated: ${target.name}`)
    return { ok: true }
  })

  ipcMain.handle('agent:import-opencode', () => {
    try {
      const p = path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
      const j = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown
      const imported = providersFromOpencode(j)
      if (imported.length === 0) {
        return {
          ok: false,
          error: '未在 opencode 配置中找到可用 provider：至少需要 Base URL；本地服务（如 Ollama）可不填 API Key'
        }
      }
      const s = loadSettings()
      const { providers, added } = mergeProviders(s.agentProviders, imported)
      const saved = saveProviders(providers, s.activeProviderId ?? providers[0]?.id ?? null)
      if (!saved.ok) return { ok: false, error: saved.error ?? '设置保存失败' }
      logLine(`[agent] imported ${added} provider(s) from opencode (total ${providers.length})`)
      return { ok: true, added }
    } catch (e) {
      return { ok: false, error: `读取 opencode 配置失败：${(e as Error)?.message ?? String(e)}` }
    }
  })

  ipcMain.handle('agent:confirm-respond', (_e, id: number, ok: boolean) => {
    const r = pendingConfirms.get(Number(id))
    if (r) {
      pendingConfirms.delete(Number(id))
      r(!!ok)
    }
    return { ok: true }
  })

  ipcMain.handle('agent:import-status', (_e, source: string) =>
    importStatus(source === 'codex' ? 'codex' : 'opencode')
  )

  ipcMain.handle('skills:list', () => listSkills())
  ipcMain.handle('skills:toggle', (_e, id: string, enabled: boolean) => {
    setSkillEnabled(String(id), !!enabled)
    return { ok: true }
  })
  ipcMain.handle('skills:remove', (_e, id: string) => removeSkill(String(id)))
  ipcMain.handle('skills:import-folder', async () => {
    if (!win) return { ok: false, error: '窗口未就绪' }
    const r = await dialog.showOpenDialog(win, {
      title: '选择要导入的 Skill 文件夹（需包含 SKILL.md）',
      properties: ['openDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, error: '已取消' }
    return importSkillFromFolder(r.filePaths[0])
  })

  ipcMain.handle('setup:codex-status', () => codexConfigStatus())
  ipcMain.handle('setup:codex-install', () => installCodexMcp(bridgeCjsPath()))
  ipcMain.handle('setup:claude-command', () => {
    const bridgePath = bridgeCjsPath()
    return {
      command: claudeMcpCommand(bridgePath),
      hint: claudeDesktopConfigHint(bridgePath),
      bridgeFound: fs.existsSync(bridgePath)
    }
  })

  ipcMain.handle('agents:list', () => listAgentTools())

  ipcMain.handle(
    'agents:add',
    (_e, name: string, dir: string, command?: string, cwd?: string) =>
      addCustomAgent(String(name ?? ''), String(dir ?? ''), String(command ?? ''), String(cwd ?? ''))
  )

  ipcMain.handle('agents:remove', (_e, id: string) => {
    stopAgentWatch()
    return removeCustomAgent(String(id))
  })

  ipcMain.handle('agents:sessions', (_e, toolId: string) => {
    const tool = findAgentTool(String(toolId))
    if (!tool?.sessionsDir) return []
    if (tool.kind === 'codex') return listCodexSessions(tool.sessionsDir)
    if (tool.kind === 'claude') return listClaudeSessions(tool.sessionsDir)
    if (tool.kind === 'gemini' || tool.kind === 'qwen') return listGeminiSessions(tool.sessionsDir)
    if (tool.kind === 'custom') return listCustomSessions(tool.sessionsDir)
    return []
  })

  ipcMain.handle('agents:session-open', (_e, toolId: string, sessionId: string, filePath: string) => {
    const tool = findAgentTool(String(toolId))
    if (!tool?.sessionsDir) return { ok: false, error: '工具不可用（未找到会话目录）' }
    return openExternalSession(tool, String(sessionId), String(filePath ?? ''))
  })

  ipcMain.handle('agents:session-send', (_e, toolId: string, message: string) => {
    const tool = findAgentTool(String(toolId))
    if (!tool) return { ok: false, error: '工具不存在（列表可能已刷新）' }
    const cur = currentExternalSession
    if (!cur || cur.toolId !== tool.id) {
      return { ok: false, error: '请先从「历史会话」中打开一个会话，再发送续聊消息' }
    }
    const msg = String(message ?? '').trim()
    if (!msg) return { ok: false, error: '消息不能为空' }
    if (liveChildren.size > 0) {
      return { ok: false, error: '已有任务在运行中，请等待完成，或点「停止」后再发送' }
    }
    maybeResumeAi()
    const meta = readSessionMeta(tool.kind, cur.file)
    const cliSessionId = meta.cliSessionId ?? path.basename(cur.file, '.jsonl')
    const spawnResult = resumeExternalSessionSpawn(
      tool,
      cliSessionId,
      meta.cwd ?? '',
      msg,
      cur.sessionId,
      getToolModel(tool.id)
    )
    if (!spawnResult.ok) return { ok: false, error: spawnResult.error }
    // optimistic echo — only after the spawn succeeded, so a failed start can
    // never leave a dangling user message in the panel; the tail skips the
    // CLI's own transcript echo of it
    pendingUserEcho = { text: msg, since: Date.now() }
    win?.webContents.send(
      'mirror:event',
      transcriptToMirrorEvent({ role: 'user', text: msg, ts: Date.now() }, cur.sessionId)
    )
    return { ok: true }
  })

  ipcMain.handle('agents:models', (_e, toolId: string) => {
    const tool = findAgentTool(String(toolId))
    if (!tool) return { current: '', candidates: [] }
    return { current: getToolModel(tool.id), candidates: listCandidateModels(tool) }
  })

  ipcMain.handle('agents:model-set', (_e, toolId: string, model: string) => {
    const tool = findAgentTool(String(toolId))
    if (!tool) return { ok: false, error: '工具不存在（列表可能已刷新）' }
    return setToolModel(tool.id, String(model ?? ''))
  })

  ipcMain.handle('agents:model-sync-global', (_e, toolId: string) => {
    const tool = findAgentTool(String(toolId))
    if (!tool) return { ok: false, error: '工具不存在（列表可能已刷新）' }
    const model = getToolModel(tool.id)
    if (!model) return { ok: false, error: '请先在面板中选择一个模型，再同步到全局' }
    return syncModelToGlobal(tool, model)
  })

  let startSessionBusy = false
  ipcMain.handle('agents:start-session', async (_e, toolId: string, message: string) => {
    if (startSessionBusy || liveChildren.size > 0) {
      return { ok: false, error: '已有任务在运行中，请等待完成，或点「停止」后再发送' }
    }
    maybeResumeAi()
    startSessionCancelled = false
    const tool = findAgentTool(String(toolId))
    if (!tool) return { ok: false, error: '工具不存在（列表可能已刷新）' }
    if (!tool.available) return { ok: false, error: `未检测到「${tool.name}」（命令或配置目录不存在）` }
    const probe = buildStartPlan(tool, '')
    if ('error' in probe) return { ok: false, error: probe.error }
    if (!tool.sessionsDir) return { ok: false, error: '未找到该工具的会话目录，无法跟随新会话' }
    const msg = String(message ?? '').trim()
    if (!msg) return { ok: false, error: '消息不能为空' }
    if (tool.kind === 'custom') {
      // custom commands run whatever the user configured — confirm exact plan
      const approved = await confirmScript({
        command: `${probe.file} ${probe.args.join(' ')}`,
        cwd: probe.cwd,
        skill: '启动自定义工具'
      })
      if (!approved) return { ok: false, error: '用户拒绝了这次启动' }
    }
    startSessionBusy = true
    try {
      const before = Date.now()
      const spawnResult = startExternalSessionSpawn(tool, msg, getToolModel(tool.id))
      if (!spawnResult.ok) return spawnResult
      const live = spawnResult.live
      const listFn =
        tool.kind === 'codex'
          ? listCodexSessions
          : tool.kind === 'claude'
            ? listClaudeSessions
            : tool.kind === 'gemini' || tool.kind === 'qwen'
              ? listGeminiSessions
              : listCustomSessions
      // Async polling (never blocks the main process between iterations; the
      // list readers themselves are cached by the transcripts module): starts
      // at 500ms and backs off up to 2s within the 20s window.
      const deadline = Date.now() + 20_000
      let delay = 500
      while (Date.now() < deadline) {
        // exit / spawn error wakes the loop immediately instead of waiting
        // for the next poll tick
        await Promise.race([
          new Promise((r) => setTimeout(r, delay)),
          live.settled
        ])
        delay = Math.min(2000, Math.round(delay * 1.5))
        if (startSessionCancelled) {
          startSessionCancelled = false
          killChildTree(live.child)
          live.killed = true
          return { ok: false, error: '已取消（用户急停）' }
        }
        if (live.killed) {
          return { ok: false, error: '已停止该进程（用户取消）' }
        }
        const newest = listFn(tool.sessionsDir)[0]
        if (newest && newest.updatedAt > before) {
          return openExternalSession(tool, newest.id, newest.file)
        }
        if (live.spawnError) {
          return { ok: false, error: `启动失败：${live.spawnError}${stderrSummary(live)}` }
        }
        if (live.exited) {
          return {
            ok: false,
            error: `进程提前退出（exit ${live.exitCode ?? '?'}），未检测到新的会话文件${stderrSummary(live)}`
          }
        }
      }
      // timed out: terminate the child before reporting, it cannot be followed
      killChildTree(live.child)
      live.killed = true
      return {
        ok: false,
        error: `启动超时（20 秒），未检测到会话文件；已终止该进程${stderrSummary(live)}`
      }
    } finally {
      startSessionBusy = false
    }
  })

  ipcMain.handle('agents:stop', (_e, toolId?: string) => ({
    ok: true,
    killed: stopExternalChildren(typeof toolId === 'string' && toolId ? toolId : undefined)
  }))

  ipcMain.handle('agents:session-close', () => {
    stopAgentWatch()
    mirrorSource = 'opencode'
    currentExternalSession = null
    pendingUserEcho = null
    return { ok: true }
  })

  ipcMain.handle('search:engine-get', () => ({
    engine: loadSettings().searchEngine,
    engines: Object.entries(SEARCH_ENGINES).map(([key, v]) => ({ key, name: v.name }))
  }))

  ipcMain.handle('search:engine-set', (_e, engine: string) => {
    const r = applySearchEngine(engine)
    if (r.ok) {
      try {
        win?.webContents.send('search:engine-changed', engine)
      } catch {
        /* window is going away */
      }
      return { ok: true }
    }
    return r
  })

  ipcMain.handle('shortcuts:get', () => ({
    shortcuts: effectiveShortcuts(loadSettings().shortcuts),
    defaults: { ...DEFAULT_SHORTCUTS }
  }))

  ipcMain.handle('shortcuts:set', (_e, partial: unknown) => {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      return { ok: false, error: '无效的快捷键设置' }
    }
    const overrides: Record<string, string> = { ...loadSettings().shortcuts }
    for (const [action, value] of Object.entries(partial as Record<string, unknown>)) {
      if (!isShortcutAction(action)) continue
      if (value === null) {
        delete overrides[action]
        continue
      }
      if (typeof value !== 'string') {
        return { ok: false, error: `「${shortcutLabel(action)}」的按键无效` }
      }
      const norm = normalizeBinding(value)
      if (!norm) return { ok: false, error: `「${shortcutLabel(action)}」的按键无法识别` }
      overrides[action] = norm
    }
    const effective = effectiveShortcuts(overrides)
    const check = validateShortcuts(effective, {
      platform: process.platform,
      emergencyKeys: loadSettings().emergencyStopKeys
    })
    if (!check.ok) return { ok: false, error: check.error }
    const saved = saveShortcuts(overrides)
    if (!saved.ok) return { ok: false, error: saved.error ?? '设置保存失败' }
    tabs?.setShortcuts(effective)
    try {
      win?.webContents.send('shortcuts:changed', effective)
    } catch {
      /* window is going away */
    }
    return { ok: true, shortcuts: effective }
  })

  ipcMain.handle('emergency:keys-get', () => ({ keys: loadSettings().emergencyStopKeys }))

  ipcMain.handle('emergency:keys-set', (_e, keys: unknown) => {
    const list: string[] = []
    const shortcutsMap = effectiveShortcuts(loadSettings().shortcuts)
    for (const k of Array.isArray(keys) ? keys : []) {
      if (typeof k !== 'string' || k.length === 0 || k.length > 32) continue
      const v = validateBinding(k)
      if (v.ok) {
        const conflict = bindingConflicts(v.combo, shortcutsMap, { platform: process.platform })
        if (conflict) {
          return { ok: false, error: `该组合已被快捷键「${conflict.label}」使用` }
        }
        list.push(v.combo)
      }
      if (list.length >= 5) break
    }
    const unique = [...new Set(list)]
    if (unique.length === 0) {
      return {
        ok: false,
        error: '请设置至少一个有效按键（F1–F12、Esc 或带 Ctrl/Alt/Shift 的组合）'
      }
    }
    const saved = saveEmergencyStopKeys(unique)
    if (!saved.ok) return { ok: false, error: saved.error ?? '设置保存失败' }
    tabs?.broadcastOverlay({ kind: 'hotkeys', keys: unique })
    return { ok: true, keys: unique }
  })

  ipcMain.handle('agents:mirror-source', (_e, source: string) => {
    const next = source === 'external' ? 'external' : 'opencode'
    if (next === 'opencode' && mirrorSource === 'external') {
      // resume after an external-tool gap: reset the panel stream to the
      // opencode session (clears external leftovers + stale busy state)
      win?.webContents.send(
        'mirror:event',
        externalEvent({
          kind: 'session-info',
          activeSessionID: sessionBus.state.activeSessionID,
          activeTitle: sessionBus.state.activeTitle ?? undefined,
          reason: 'selected',
          ts: Date.now()
        })
      )
      win?.webContents.send(
        'mirror:event',
        externalEvent({
          kind: 'session',
          sessionID: sessionBus.state.activeSessionID ?? 'opencode',
          status: 'idle',
          ts: Date.now()
        })
      )
    }
    mirrorSource = next
    return { ok: true }
  })
}

app.on('window-all-closed', () => {
  // standard app behavior: stay resident on macOS until Cmd+Q
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  // macOS dock click: recreate the window when none is open, else bring it back
  if (!app.isReady()) return
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }
  createWindow()
})

app.on('will-quit', () => {
  for (const entry of liveChildren) {
    killChildTree(entry.child)
  }
  liveChildren.clear()
  removeEndpoint(process.pid)
  httpServer?.close()
})
