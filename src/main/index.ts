import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
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
  saveProviders,
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
import { resolveAddress } from '../shared/url'
import { searchUrl } from '../shared/search'
import type { ContentBounds } from '../shared/protocol'

const VERSION = '0.1.0'
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
let acrylicWindow = false
let agentRuntime: AgentRuntime | null = null
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

  const execute = createToolExecutor(tabs!)
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

  // built-in agent mode (optional alternative to the opencode path)
  agentRuntime = new AgentRuntime(
    executeWithWake,
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
      win?.webContents.send('tabs:update', tabs!.list(), tabs!.activeId)
    }
  )
  tabs.createTab()

  mirror.onEvent = (ev) => {
    win?.webContents.send('mirror:event', ev)
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
              const url = addr.kind === 'url' ? addr.url : searchUrl(addr.query)
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
              url = addr.kind === 'url' ? addr.url : searchUrl(addr.query)
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

  ipcMain.handle('theme:get', () => loadSettings())

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
      input: { id?: string; name?: string; baseUrl?: string; apiKey?: string; model?: string }
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
          apiKey: apiKeyInput || prev.apiKey
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
        apiKey: apiKeyInput
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
}

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  removeEndpoint(process.pid)
  httpServer?.close()
})
