import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { TabManager } from './tabs'
import { MirrorStore } from './mirror'
import { createToolExecutor, type ToolExecutor } from './tool-handlers'
import { startHttpServer, type RunningHttpServer } from './http-server'
import { consumeTakeover, hideAllVisuals, noteTakeover } from './overlay'
import { abortOperation, beginOperation, endOperation, runInOperation } from './interrupt'
import {
  createAnnotationSubmitHandler,
  type AnnotationSubmitHandler,
  type AnnotationSubmitPayload
} from './annotations'
import { cobrowseDir, removeEndpoint, writeEndpoint } from '../shared/endpoint'
import {
  activeAgentConfig,
  loadSettings,
  saveEmergencyStopKeys,
  saveProviders,
  saveSearchEngine,
  saveSession,
  saveTheme,
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
import { SEARCH_ENGINES, searchUrl } from '../shared/search'
import type { ContentBounds } from '../shared/protocol'
import { isLlmProtocol } from '../shared/llm'

const VERSION = '0.2.0'
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

// script-execution confirmation round trip (run_skill_script → renderer dialog);
// module scope so both the agent wiring and the IPC handlers can reach it
const pendingConfirms = new Map<number, (ok: boolean) => void>()
let confirmSeq = 0
const confirmScript = (payload: {
  command: string
  cwd: string
  skill: string
}): Promise<boolean> =>
  new Promise((resolve) => {
    const id = ++confirmSeq
    pendingConfirms.set(id, resolve)
    win?.webContents.send('agent:confirm-request', { id, ...payload })
    setTimeout(() => {
      if (pendingConfirms.delete(id)) resolve(false)
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
      skill: payload.kind === 'write' ? 'write_file（写文件）' : 'run_command（执行命令）'
    })
    setTimeout(() => {
      if (pendingConfirms.delete(id)) resolve(false)
    }, 120_000)
  })
)

// external agent transcripts: history replay + live tail, plus panel replies
// (Codex `exec resume` / Claude Code `--resume` write back to the same transcript)
let agentWatch: { timer: ReturnType<typeof setInterval> } | null = null
let externalEvtSeq = 5_000_000
/** While an external transcript is open, opencode pushes are muted. */
let mirrorSource: 'opencode' | 'external' = 'opencode'

/** The external transcript currently open in the panel (reply target). */
let currentExternalSession: { toolId: string; kind: string; sessionId: string; file: string } | null =
  null

/** User message just injected via resume — the CLI transcript will echo it; skip that echo. */
let pendingUserEcho: { text: string; since: number } | null = null

function stopAgentWatch(): void {
  if (agentWatch) {
    clearInterval(agentWatch.timer)
    agentWatch = null
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

/** Tail a transcript file; stream newly appended messages into the panel. */
function startAgentWatch(
  kind: string,
  file: string,
  sessionID: string,
  baselineSize?: number
): void {
  stopAgentWatch()
  let lastSize = 0
  try {
    lastSize = baselineSize ?? fs.statSync(file).size
  } catch {
    return
  }
  let missCount = 0
  const timer = setInterval(() => {
    try {
      const st = fs.statSync(file)
      missCount = 0
      if (st.size < lastSize) {
        // file was truncated or rotated — restart from the beginning
        lastSize = 0
      }
      if (st.size <= lastSize) return
      const fd = fs.openSync(file, 'r')
      let text = ''
      try {
        const len = st.size - lastSize
        const buf = Buffer.alloc(len)
        const n = fs.readSync(fd, buf, 0, len, lastSize)
        text = buf.subarray(0, n).toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
      const cut = text.lastIndexOf('\n')
      if (cut < 0) return // wait for a complete line
      const complete = text.slice(0, cut + 1)
      lastSize += Buffer.byteLength(complete, 'utf8')
      for (const m of parseTranscriptChunk(kind, complete)) {
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
        win?.webContents.send('mirror:event', transcriptToMirrorEvent(m, sessionID))
      }
    } catch {
      missCount++
      if (missCount >= 20) stopAgentWatch()
    }
  }, 1500)
  agentWatch = { timer }
}

/** Open a transcript file: reset the panel, stream history, then tail live. */
function openExternalSession(
  tool: { id: string; kind: string; sessionsDir?: string },
  sessionId: string,
  file: string
): { ok: boolean; count?: number; title?: string; error?: string } {
  const root = path.resolve(tool.sessionsDir ?? '')
  if (!path.resolve(file).startsWith(root)) return { ok: false, error: '非法路径' }
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
  win?.webContents.send(
    'mirror:event',
    externalEvent({
      kind: 'session-info',
      activeSessionID: sid,
      activeTitle: path.basename(file),
      reason: 'selected',
      ts: Date.now()
    })
  )
  for (const m of msgs) {
    win?.webContents.send('mirror:event', transcriptToMirrorEvent(m, sid))
  }
  startAgentWatch(tool.kind, file, sid, baseline)
  return { ok: true, count: msgs.length, title: path.basename(file) }
}

/** Live child processes spawned for external sessions (killed on quit). */
const liveChildren = new Set<ReturnType<typeof spawn>>()
let startSessionCancelled = false

function broadcastChildren(): void {
  win?.webContents.send('agents:children', liveChildren.size)
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

/** Spawn a headless CLI run that starts a brand-new session (generalized). */
function startExternalSessionSpawn(
  tool: { kind: string; command?: string },
  message: string,
  model?: string
): { ok: boolean; error?: string } {
  const plan = buildStartPlan(tool as never, message, model)
  if ('error' in plan) return { ok: false, error: plan.error }
  try {
    const child = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore']
    })
    liveChildren.add(child)
    broadcastChildren()
    child.on('exit', () => {
      liveChildren.delete(child)
      broadcastChildren()
    })
    // a broken pipe / missing binary must never crash the main process
    child.stdin?.on('error', () => undefined)
    child.on('error', () => undefined)
    if (plan.useStdin) {
      try {
        child.stdin?.write(message)
      } catch {
        /* child may already be gone */
      }
    }
    child.stdin?.end()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? '启动失败' }
  }
}

/** Spawn a headless CLI run that CONTINUES an existing session ("reply from the panel"). */
function resumeExternalSessionSpawn(
  tool: { kind: string },
  cliSessionId: string,
  cwdHint: string,
  message: string,
  sessionID: string,
  model?: string
): { ok: boolean; error?: string } {
  const plan = buildResumePlan(tool as never, cliSessionId, cwdHint, model)
  if ('error' in plan) return { ok: false, error: plan.error }
  try {
    const child = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    })
    liveChildren.add(child)
    broadcastChildren()
    let errBuf = ''
    child.stderr?.on('data', (d: Buffer) => {
      errBuf = (errBuf + d.toString('utf8')).slice(-2000)
    })
    child.on('exit', (code) => {
      liveChildren.delete(child)
      broadcastChildren()
      const detail = errBuf.trim()
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
    child.on('error', () => undefined)
    try {
      child.stdin?.write(message)
    } catch {
      /* child may already be gone */
    }
    child.stdin?.end()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? '启动失败' }
  }
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
  const settings = loadSettings()
  nativeTheme.themeSource = settings.theme
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
    if (consumeTakeover()) {
      logLine('[takeover] pending takeover consumed; tool call blocked')
      return {
        content: [
          {
            type: 'text',
            text: '用户已接管浏览器（按下 Esc / 点击了状态条）。本次调用未执行。请等待用户的下一步指示，不要重试。'
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

  // skill tools (read_skill / run_skill_script …) are only wired into the
  // built-in agent path (handlers + confirmation live at module scope)
  const executeWithSkills: ToolExecutor = async (name, args) => {
    const h = skillHandlers[name] ?? fsHandlers[name]
    if (h) return h(args)
    return executeWithWake(name, args)
  }

  // built-in agent mode (optional alternative to the opencode path)
  agentRuntime = new AgentRuntime(
    executeWithSkills,
    () => activeAgentConfig(),
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
      await agentRuntime?.send(text)
    },
    agentBusy: () => agentRuntime?.isRunning ?? false,
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
        : undefined
  })

  const annotationSubmit = createAnnotationSubmitHandler(tabs!, mirror)
  annotationSubmitHandler = (payload) => annotationSubmit(payload)

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

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win?.webContents.toggleDevTools()
      e.preventDefault()
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
      } catch {
        /* window is going away */
      }
    }
  )
  tabs.createTab()

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

function setupIpc(): void {
  ipcMain.handle('ui:ready', () => ({
    tabs: tabs?.list() ?? [],
    activeTabId: tabs?.activeId ?? null,
    mirror: mirror.snapshot()
  }))

  ipcMain.on('ui:bounds', (_e, bounds: ContentBounds) => {
    tabs?.updateBounds(bounds)
  })

  ipcMain.handle(
    'tabs:action',
    (_e, action: { type: string; url?: string; tabId?: number }) => {
      if (!tabs) return { ok: false }
      try {
        switch (action.type) {
          case 'navigate': {
            const tab = tabs.requireTab(null)
            if (action.url) {
              const addr = resolveAddress(action.url)
              const url =
                addr.kind === 'url' ? addr.url : searchUrl(addr.query, loadSettings().searchEngine)
              void tab.view.webContents.loadURL(url)
            }
            break
          }
          case 'back': {
            const tab = tabs.requireTab(null)
            const nav = tab.view.webContents.navigationHistory
            if (nav.canGoBack()) nav.goBack()
            break
          }
          case 'forward': {
            const tab = tabs.requireTab(null)
            const nav = tab.view.webContents.navigationHistory
            if (nav.canGoForward()) nav.goForward()
            break
          }
          case 'reload': {
            const tab = tabs.requireTab(null)
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
          case 'annotationMode': {
            const tab = tabs.requireTab(null)
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

  ipcMain.on(
    'overlay:event',
    (_e, ev: { kind?: string; via?: string; annotationId?: string }) => {
      if (ev?.kind === 'takeover') {
        const aborted = abortOperation()
        const consumed = noteTakeover()
        logLine(
          `[overlay] takeover via ${ev.via ?? 'unknown'} (aborted=${aborted}, in-window=${consumed})`
        )
        if (aborted || consumed) hideAllVisuals(tabs?.getActive() ?? null)
        return
      }
      if (ev?.kind === 'annotationSubmit') {
        if (!annotationSubmitHandler) return
        void annotationSubmitHandler(ev as unknown as AnnotationSubmitPayload).then((r) => {
          logLine(
            `[annotation] submit ${ev.annotationId ?? '?'} -> ${r.ok ? 'queued' : 'error: ' + (r.error ?? '')}`
          )
        })
        return
      }
      if (ev?.kind === 'annotationDismiss') {
        logLine(`[annotation] dismissed ${ev.annotationId ?? '?'}`)
      }
    }
  )

  ipcMain.handle('chat:send', (_e, text: string) => {
    const t = String(text ?? '').trim()
    if (!t) return { ok: false }
    const inj = mirror.addInjection(t, 'panel')
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
        if (sessionBus.state.activeSessionID) {
          // ask some plugin instance to push the session's history so the
          // panel shows the context of the session we just switched to
          sessionBus.push({ action: 'history', sessionID: sessionBus.state.activeSessionID })
          saveSession({
            id: sessionBus.state.activeSessionID,
            title: sessionBus.state.activeTitle ?? ''
          })
        } else {
          saveSession(null)
        }
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
    saveTheme(t)
    nativeTheme.themeSource = t
    applyWindowBackground()
    logLine(`[theme] set to ${t}`)
    return { ok: true, theme: t }
  })

  ipcMain.handle('agent:send', async (_e, text: string) => {
    if (!agentRuntime) return { ok: false, error: 'agent not ready' }
    try {
      await agentRuntime.send(String(text ?? ''))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) }
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
      }
    ) => {
      const s = loadSettings()
      const baseUrl = String(input?.baseUrl ?? '').trim()
      if (!baseUrl) return { ok: false, error: 'Base URL 不能为空' }
      const list = s.agentProviders.slice()
      const idx = input?.id ? list.findIndex((p) => p.id === input.id) : -1
      const apiKeyInput = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
      if (idx >= 0) {
        const prev = list[idx]
        list[idx] = {
          ...prev,
          name: String(input?.name ?? '').trim() || prev.name || deriveName(baseUrl),
          baseUrl,
          model: String(input?.model ?? '').trim(),
          apiKey: apiKeyInput || prev.apiKey,
          protocol: isLlmProtocol(input?.protocol) ? input.protocol : prev.protocol,
          authType:
            input?.authType === 'import' ? 'import' : input?.authType === 'key' ? 'key' : prev.authType,
          authSource:
            input?.authSource === 'codex' || input?.authSource === 'opencode'
              ? input.authSource
              : input?.authType === 'key'
                ? undefined
                : prev.authSource
        }
        saveProviders(list, s.activeProviderId)
        logLine(`[agent] provider updated: ${deriveName(baseUrl)}`)
        return { ok: true }
      }
      const id = newProviderId()
      list.push({
        id,
        name: String(input?.name ?? '').trim() || deriveName(baseUrl),
        baseUrl,
        model: String(input?.model ?? '').trim(),
        apiKey: apiKeyInput,
        protocol: isLlmProtocol(input?.protocol) ? input.protocol : 'openai-chat',
        authType: input?.authType === 'import' ? 'import' : 'key',
        authSource:
          input?.authSource === 'codex' || input?.authSource === 'opencode'
            ? input.authSource
            : undefined
      })
      const active = s.activeProviderId ?? id
      saveProviders(list, active)
      logLine(`[agent] provider added: ${deriveName(baseUrl)} (active=${active === id})`)
      return { ok: true, id }
    }
  )

  ipcMain.handle('agent:provider-remove', (_e, id: string) => {
    const s = loadSettings()
    const list = s.agentProviders.filter((p) => p.id !== id)
    const active = s.activeProviderId === id ? (list[0]?.id ?? null) : s.activeProviderId
    saveProviders(list, active)
    logLine(`[agent] provider removed: ${String(id)}`)
    return { ok: true }
  })

  ipcMain.handle('agent:provider-activate', (_e, id: string) => {
    const s = loadSettings()
    const target = s.agentProviders.find((p) => p.id === id)
    if (!target) return { ok: false, error: 'provider not found' }
    saveProviders(s.agentProviders, id)
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
          error: '未在 opencode 配置中找到可用 provider（需要同时有 apiKey 和 baseURL）'
        }
      }
      const s = loadSettings()
      const { providers, added } = mergeProviders(s.agentProviders, imported)
      saveProviders(providers, s.activeProviderId ?? providers[0]?.id ?? null)
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

  ipcMain.handle('agents:add', (_e, name: string, dir: string, command?: string) =>
    addCustomAgent(String(name ?? ''), String(dir ?? ''), String(command ?? ''))
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
      return { ok: false, error: '有任务正在运行：请等待完成，或点「停止」后再发送' }
    }
    const meta = readSessionMeta(tool.kind, cur.file)
    const cliSessionId = meta.cliSessionId ?? path.basename(cur.file, '.jsonl')
    // optimistic echo so the panel shows the outgoing message immediately;
    // the tail skips the CLI's own transcript echo of it
    pendingUserEcho = { text: msg, since: Date.now() }
    win?.webContents.send(
      'mirror:event',
      transcriptToMirrorEvent({ role: 'user', text: msg, ts: Date.now() }, cur.sessionId)
    )
    return resumeExternalSessionSpawn(
      tool,
      cliSessionId,
      meta.cwd ?? '',
      msg,
      cur.sessionId,
      getToolModel(tool.id)
    )
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
      return { ok: false, error: '有任务正在运行：请等待完成，或点「停止」后再发送' }
    }
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
      const listFn =
        tool.kind === 'codex'
          ? listCodexSessions
          : tool.kind === 'claude'
            ? listClaudeSessions
            : tool.kind === 'gemini' || tool.kind === 'qwen'
              ? listGeminiSessions
              : listCustomSessions
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        if (startSessionCancelled) {
          startSessionCancelled = false
          return { ok: false, error: '已取消' }
        }
        const newest = listFn(tool.sessionsDir)[0]
        if (newest && newest.updatedAt > before) {
          return openExternalSession(tool, newest.id, newest.file)
        }
      }
      return { ok: false, error: '已启动，但未在 20 秒内检测到新会话文件；可点 ⟳ 刷新会话列表' }
    } finally {
      startSessionBusy = false
    }
  })

  ipcMain.handle('agents:stop', () => {
    startSessionCancelled = true
    let killed = 0
    for (const child of liveChildren) {
      killChildTree(child)
      killed++
    }
    liveChildren.clear()
    broadcastChildren()
    return { ok: true, killed }
  })

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
    if (typeof engine === 'string' && engine in SEARCH_ENGINES) {
      saveSearchEngine(engine as keyof typeof SEARCH_ENGINES)
    }
    return { ok: true }
  })

  ipcMain.handle('emergency:keys-get', () => ({ keys: loadSettings().emergencyStopKeys }))

  ipcMain.handle('emergency:keys-set', (_e, keys: unknown) => {
    const list = Array.isArray(keys)
      ? keys
          .filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 20)
          .slice(0, 5)
      : []
    const unique = [...new Set(list)]
    if (unique.length === 0) return { ok: false, error: '至少需要一个按键' }
    saveEmergencyStopKeys(unique)
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
  app.quit()
})

app.on('will-quit', () => {
  for (const child of liveChildren) {
    killChildTree(child)
  }
  liveChildren.clear()
  removeEndpoint(process.pid)
  httpServer?.close()
})
