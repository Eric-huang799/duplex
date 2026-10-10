import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserDataSnapshot, ChatSendResult, CollaborationState, ContentBounds, DownloadRecord, ExternalSessionState, LoadErrorInfo } from '../shared/protocol'

type TabAction = { type: string; url?: string; tabId?: number; value?: number }

const api = {
  ready: () => ipcRenderer.invoke('ui:ready') as Promise<unknown>,
  onTabs: (cb: (tabs: unknown, activeTabId: number | null) => void): (() => void) => {
    const listener = (_e: unknown, tabs: unknown, activeTabId: number | null): void =>
      cb(tabs, activeTabId)
    ipcRenderer.on('tabs:update', listener)
    return () => ipcRenderer.removeListener('tabs:update', listener)
  },
  onMirror: (cb: (ev: unknown) => void): (() => void) => {
    const listener = (_e: unknown, ev: unknown): void => cb(ev)
    ipcRenderer.on('mirror:event', listener)
    return () => ipcRenderer.removeListener('mirror:event', listener)
  },
  setContentBounds: (b: ContentBounds): void => {
    ipcRenderer.send('ui:bounds', b)
  },
  setChromeOverlay: (id: string, open: boolean): void => {
    ipcRenderer.send('browser:chrome-overlay', id, open)
  },
  tabAction: (action: TabAction) => ipcRenderer.invoke('tabs:action', action) as Promise<unknown>,
  browserData: () => ipcRenderer.invoke('browser:data') as Promise<BrowserDataSnapshot>,
  onBrowserData: (cb: (data: BrowserDataSnapshot) => void): (() => void) => {
    const listener = (_e: unknown, data: BrowserDataSnapshot): void => cb(data)
    ipcRenderer.on('browser:data-update', listener)
    return () => ipcRenderer.removeListener('browser:data-update', listener)
  },
  bookmarkToggle: (record: { url: string; title: string; favicon?: string }) =>
    ipcRenderer.invoke('browser:bookmark-toggle', record) as Promise<{ bookmarked: boolean }>,
  historyRemove: (url: string, visitedAt: number) =>
    ipcRenderer.invoke('browser:history-remove', url, visitedAt) as Promise<{ ok: boolean }>,
  historyClear: () => ipcRenderer.invoke('browser:history-clear') as Promise<{ ok: boolean }>,
  downloadsList: () => ipcRenderer.invoke('downloads:list') as Promise<DownloadRecord[]>,
  downloadsCancel: (id: string) => ipcRenderer.invoke('downloads:cancel', id) as Promise<{ ok: boolean }>,
  downloadsClear: () => ipcRenderer.invoke('downloads:clear') as Promise<{ ok: boolean }>,
  downloadsOpen: (id: string) =>
    ipcRenderer.invoke('downloads:open', id) as Promise<{ ok: boolean; error?: string }>,
  downloadsReveal: (id: string) =>
    ipcRenderer.invoke('downloads:reveal', id) as Promise<{ ok: boolean; error?: string }>,
  onDownloads: (cb: (rows: DownloadRecord[]) => void): (() => void) => {
    const listener = (_e: unknown, rows: DownloadRecord[]): void => cb(rows)
    ipcRenderer.on('downloads:update', listener)
    return () => ipcRenderer.removeListener('downloads:update', listener)
  },
  onBrowserShortcut: (cb: (action: string) => void): (() => void) => {
    const listener = (_e: unknown, action: string): void => cb(action)
    ipcRenderer.on('browser:shortcut', listener)
    return () => ipcRenderer.removeListener('browser:shortcut', listener)
  },
  getPlatform: (): string => process.platform,
  onFindResult: (cb: (r: { tabId: number; matches: number; activeMatch: number }) => void): (() => void) => {
    const listener = (_e: unknown, r: { tabId: number; matches: number; activeMatch: number }): void => cb(r)
    ipcRenderer.on('browser:find-result', listener)
    return () => ipcRenderer.removeListener('browser:find-result', listener)
  },
  showTabContextMenu: (tabId: number, x: number, y: number): void => {
    ipcRenderer.send('tabs:context-menu', tabId, x, y)
  },
  showEngineMenu: (x: number, y: number): void => {
    ipcRenderer.send('search:engine-menu', x, y)
  },
  showToolsMenu: (
    x: number,
    y: number,
    state: { annotationActive: boolean; theme: string }
  ): void => {
    ipcRenderer.send('tools:menu', x, y, state)
  },
  onSearchEngineChanged: (cb: (engine: string) => void): (() => void) => {
    const listener = (_e: unknown, engine: string): void => cb(engine)
    ipcRenderer.on('search:engine-changed', listener)
    return () => ipcRenderer.removeListener('search:engine-changed', listener)
  },
  onThemeChanged: (cb: (theme: 'system' | 'light' | 'dark') => void): (() => void) => {
    const listener = (_e: unknown, theme: 'system' | 'light' | 'dark'): void => cb(theme)
    ipcRenderer.on('theme:changed', listener)
    return () => ipcRenderer.removeListener('theme:changed', listener)
  },
  downloadConfirmGet: () =>
    ipcRenderer.invoke('downloads:confirm-get') as Promise<{ enabled: boolean }>,
  downloadConfirmSet: (enabled: boolean) =>
    ipcRenderer.invoke('downloads:confirm-set', enabled) as Promise<{ ok: boolean; error?: string }>,
  shortcutsGet: () =>
    ipcRenderer.invoke('shortcuts:get') as Promise<{
      shortcuts: Record<string, string>
      defaults: Record<string, string>
    }>,
  shortcutsSet: (partial: Record<string, string | null>) =>
    ipcRenderer.invoke('shortcuts:set', partial) as Promise<{
      ok: boolean
      error?: string
      shortcuts?: Record<string, string>
    }>,
  onShortcutsChanged: (cb: (map: Record<string, string>) => void): (() => void) => {
    const listener = (_e: unknown, map: Record<string, string>): void => cb(map)
    ipcRenderer.on('shortcuts:changed', listener)
    return () => ipcRenderer.removeListener('shortcuts:changed', listener)
  },
  bookmarkAdd: (record: { url: string; title: string; favicon?: string; folder?: string }) =>
    ipcRenderer.invoke('browser:bookmark-add', record) as Promise<{ ok: boolean; error?: string }>,
  bookmarkUpdate: (url: string, patch: { title?: string; url?: string; folder?: string }) =>
    ipcRenderer.invoke('browser:bookmark-update', url, patch) as Promise<{
      ok: boolean
      error?: string
    }>,
  bookmarkRemove: (url: string) =>
    ipcRenderer.invoke('browser:bookmark-remove', url) as Promise<{ ok: boolean }>,
  bookmarkFolderAdd: (name: string) =>
    ipcRenderer.invoke('browser:bookmark-folder-add', name) as Promise<{
      ok: boolean
      error?: string
    }>,
  bookmarkFolderRemove: (name: string) =>
    ipcRenderer.invoke('browser:bookmark-folder-remove', name) as Promise<{ ok: boolean }>,
  bookmarkFolderRename: (oldName: string, newName: string) =>
    ipcRenderer.invoke('browser:bookmark-folder-rename', oldName, newName) as Promise<{
      ok: boolean
      error?: string
    }>,
  onLoadError: (cb: (info: LoadErrorInfo) => void): (() => void) => {
    const listener = (_e: unknown, info: LoadErrorInfo): void => cb(info)
    ipcRenderer.on('browser:load-error', listener)
    return () => ipcRenderer.removeListener('browser:load-error', listener)
  },
  setPanelMode: (mode: 'opencode' | 'agent' | 'external') =>
    ipcRenderer.invoke('ui:panel-mode', mode) as Promise<{ ok: boolean }>,
  sendChat: (text: string) => ipcRenderer.invoke('chat:send', text) as Promise<ChatSendResult>,
  annotationToggle: () =>
    ipcRenderer.invoke('annotation:toggle') as Promise<{ ok: boolean; active: boolean }>,
  onAnnotationState: (cb: (active: boolean) => void): (() => void) => {
    const listener = (_e: unknown, active: boolean): void => cb(!!active)
    ipcRenderer.on('annotation:state', listener)
    return () => ipcRenderer.removeListener('annotation:state', listener)
  },
  getTheme: () => ipcRenderer.invoke('theme:get') as Promise<{ theme: 'system' | 'light' | 'dark' }>,
  setTheme: (theme: 'system' | 'light' | 'dark') =>
    ipcRenderer.invoke('theme:set', theme) as Promise<{ ok: boolean; theme?: string; error?: string }>,
  sessionCommand: (cmd: { action: string; sessionID?: string | null; title?: string }) =>
    ipcRenderer.invoke('session:command', cmd) as Promise<unknown>,
  sessionState: () => ipcRenderer.invoke('session:state') as Promise<unknown>,
  onAgent: (cb: (ev: unknown) => void): (() => void) => {
    const listener = (_e: unknown, ev: unknown): void => cb(ev)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  agentSend: (text: string, options?: { interrupt?: boolean }) => ipcRenderer.invoke('agent:send', text, options) as Promise<unknown>,
  agentAbort: () => ipcRenderer.invoke('agent:abort') as Promise<unknown>,
  agentReset: () => ipcRenderer.invoke('agent:reset') as Promise<unknown>,
  agentNewSession: () => ipcRenderer.invoke('agent:new-session') as Promise<unknown>,
  agentSessions: () => ipcRenderer.invoke('agent:sessions') as Promise<unknown>,
  agentSwitchSession: (id: string) =>
    ipcRenderer.invoke('agent:switch-session', id) as Promise<{ ok: boolean; error?: string }>,
  agentDeleteSession: (id: string) =>
    ipcRenderer.invoke('agent:delete-session', id) as Promise<{ ok: boolean; error?: string }>,
  agentEvents: () => ipcRenderer.invoke('agent:events') as Promise<unknown>,
  agentProviders: () => ipcRenderer.invoke('agent:providers') as Promise<unknown>,
  agentProviderSave: (cfg: {
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
  }) =>
    ipcRenderer.invoke('agent:provider-save', cfg) as Promise<{
      ok: boolean
      error?: string
      id?: string
    }>,
  agentProviderRemove: (id: string) =>
    ipcRenderer.invoke('agent:provider-remove', id) as Promise<{ ok: boolean; error?: string }>,
  agentProviderActivate: (id: string) =>
    ipcRenderer.invoke('agent:provider-activate', id) as Promise<{ ok: boolean; error?: string }>,
  agentImportOpencode: () => ipcRenderer.invoke('agent:import-opencode') as Promise<unknown>,
  agentImportStatus: (source: string) =>
    ipcRenderer.invoke('agent:import-status', source) as Promise<{
      found: boolean
      path: string
      providers: string[]
      expiresAt?: number
      error?: string
    }>,
  onAgentConfirm: (
    cb: (req: {
      id: number
      command: string
      cwd: string
      skill: string
      tool?: string
      kind?: 'write' | 'command' | 'script'
      preview?: string
      expiresAt?: number
    }) => void
  ): (() => void) => {
    const listener = (
      _e: unknown,
      req: { id: number; command: string; cwd: string; skill: string }
    ): void => cb(req)
    ipcRenderer.on('agent:confirm-request', listener)
    return () => ipcRenderer.removeListener('agent:confirm-request', listener)
  },
  agentConfirmRespond: (id: number, ok: boolean) =>
    ipcRenderer.invoke('agent:confirm-respond', id, ok) as Promise<{ ok: boolean }>,
  skillsList: () => ipcRenderer.invoke('skills:list') as Promise<unknown>,
  skillsToggle: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('skills:toggle', id, enabled) as Promise<{ ok: boolean }>,
  skillsRemove: (id: string) =>
    ipcRenderer.invoke('skills:remove', id) as Promise<{ ok: boolean; error?: string }>,
  skillsImportFolder: () =>
    ipcRenderer.invoke('skills:import-folder') as Promise<{ ok: boolean; error?: string }>,
  setupCodexStatus: () => ipcRenderer.invoke('setup:codex-status') as Promise<unknown>,
  setupCodexInstall: () =>
    ipcRenderer.invoke('setup:codex-install') as Promise<{
      ok: boolean
      error?: string
      backupPath?: string
    }>,
  setupClaudeCommand: () =>
    ipcRenderer.invoke('setup:claude-command') as Promise<{
      command: string
      hint: string
      bridgeFound: boolean
    }>,
  agentsList: () => ipcRenderer.invoke('agents:list') as Promise<unknown>,
  agentsAdd: (name: string, dir: string, command?: string, cwd?: string) =>
    ipcRenderer.invoke('agents:add', name, dir, command, cwd) as Promise<{
      ok: boolean
      id?: string
      error?: string
    }>,
  agentsRemove: (id: string) =>
    ipcRenderer.invoke('agents:remove', id) as Promise<{ ok: boolean; error?: string }>,
  agentsSessions: (toolId: string) =>
    ipcRenderer.invoke('agents:sessions', toolId) as Promise<unknown>,
  agentsSessionOpen: (toolId: string, sessionId: string, file: string) =>
    ipcRenderer.invoke('agents:session-open', toolId, sessionId, file) as Promise<{
      ok: boolean
      count?: number
      title?: string
      error?: string
    }>,
  agentsSessionSend: (toolId: string, message: string) =>
    ipcRenderer.invoke('agents:session-send', toolId, message) as Promise<{
      ok: boolean
      error?: string
    }>,
  agentsModels: (toolId: string) =>
    ipcRenderer.invoke('agents:models', toolId) as Promise<{
      current: string
      candidates: Array<{ id: string; label: string }>
    }>,
  agentsModelSet: (toolId: string, model: string) =>
    ipcRenderer.invoke('agents:model-set', toolId, model) as Promise<{ ok: boolean; error?: string }>,
  agentsModelSyncGlobal: (toolId: string) =>
    ipcRenderer.invoke('agents:model-sync-global', toolId) as Promise<{
      ok: boolean
      path?: string
      backupPath?: string
      error?: string
    }>,
  agentsSessionClose: () => ipcRenderer.invoke('agents:session-close') as Promise<{ ok: boolean }>,
  externalState: () => ipcRenderer.invoke('external:get') as Promise<ExternalSessionState | null>,
  onExternalState: (cb: (state: ExternalSessionState | null) => void): (() => void) => {
    const listener = (_e: unknown, state: ExternalSessionState | null): void => cb(state)
    ipcRenderer.on('external:state', listener)
    return () => ipcRenderer.removeListener('external:state', listener)
  },
  collaborationGet: () => ipcRenderer.invoke('collaboration:get') as Promise<CollaborationState>,
  collaborationResume: (tabId: number) => ipcRenderer.invoke('collaboration:resume', tabId) as Promise<{ ok: boolean; error?: string }>,
  onCollaborationState: (cb: (state: CollaborationState) => void): (() => void) => {
    const listener = (_e: unknown, state: CollaborationState): void => cb(state)
    ipcRenderer.on('collaboration:state', listener)
    return () => ipcRenderer.removeListener('collaboration:state', listener)
  },
  agentsSetMirrorSource: (source: 'opencode' | 'external') =>
    ipcRenderer.invoke('agents:mirror-source', source) as Promise<{ ok: boolean }>,
  agentsStop: (toolId?: string) =>
    ipcRenderer.invoke('agents:stop', toolId) as Promise<{ ok: boolean; killed: number }>,
  emergencyKeysGet: () =>
    ipcRenderer.invoke('emergency:keys-get') as Promise<{ keys: string[] }>,
  emergencyKeysSet: (keys: string[]) =>
    ipcRenderer.invoke('emergency:keys-set', keys) as Promise<{
      ok: boolean
      keys?: string[]
      error?: string
    }>,
  emergencyTakeover: (): void => {
    ipcRenderer.send('overlay:event', { kind: 'takeover', via: 'hotkey' })
  },
  resumeAi: (): void => {
    ipcRenderer.send('emergency:resume')
  },
  onEmergencyState: (cb: (s: { paused: boolean }) => void): (() => void) => {
    const listener = (_e: unknown, s: { paused: boolean }): void => cb(s)
    ipcRenderer.on('emergency:state', listener)
    return () => ipcRenderer.removeListener('emergency:state', listener)
  },
  onEmergencyStop: (
    cb: (s: { via?: string; aborted?: boolean; killed?: number; dropped?: number }) => void
  ): (() => void) => {
    const listener = (
      _e: unknown,
      s: { via?: string; aborted?: boolean; killed?: number; dropped?: number }
    ): void => cb(s)
    ipcRenderer.on('emergency:stop', listener)
    return () => ipcRenderer.removeListener('emergency:stop', listener)
  },
  onAgentConfirmCancel: (cb: (s: { id?: number }) => void): (() => void) => {
    const listener = (_e: unknown, s: { id?: number } | undefined): void => cb(s ?? {})
    ipcRenderer.on('agent:confirm-cancel', listener)
    return () => ipcRenderer.removeListener('agent:confirm-cancel', listener)
  },
  onAgentsChildren: (cb: (count: number) => void): (() => void) => {
    const listener = (_e: unknown, n: number): void => cb(Number(n) || 0)
    ipcRenderer.on('agents:children', listener)
    return () => ipcRenderer.removeListener('agents:children', listener)
  },
  onAgentsWatchError: (cb: (s: { toolId: string; error: string }) => void): (() => void) => {
    const listener = (_e: unknown, s: { toolId: string; error: string }): void => cb(s)
    ipcRenderer.on('agents:watch-error', listener)
    return () => ipcRenderer.removeListener('agents:watch-error', listener)
  },
  searchEngineGet: () =>
    ipcRenderer.invoke('search:engine-get') as Promise<{
      engine: string
      engines: Array<{ key: string; name: string }>
    }>,
  searchEngineSet: (engine: string) =>
    ipcRenderer.invoke('search:engine-set', engine) as Promise<{ ok: boolean; error?: string }>,
  agentsStartSession: (toolId: string, message: string) =>
    ipcRenderer.invoke('agents:start-session', toolId, message) as Promise<{
      ok: boolean
      count?: number
      title?: string
      error?: string
    }>
}

contextBridge.exposeInMainWorld('cobrowse', api)

export type CobrowsePreloadApi = typeof api
