import { contextBridge, ipcRenderer } from 'electron'
import type { ContentBounds } from '../shared/protocol'

type TabAction = { type: string; url?: string; tabId?: number }

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
  tabAction: (action: TabAction) => ipcRenderer.invoke('tabs:action', action) as Promise<unknown>,
  sendChat: (text: string) => ipcRenderer.invoke('chat:send', text) as Promise<unknown>,
  getTheme: () => ipcRenderer.invoke('theme:get') as Promise<{ theme: 'system' | 'light' | 'dark' }>,
  setTheme: (theme: 'system' | 'light' | 'dark') =>
    ipcRenderer.invoke('theme:set', theme) as Promise<{ ok: boolean; theme: string }>,
  sessionCommand: (cmd: { action: string; sessionID?: string | null; title?: string }) =>
    ipcRenderer.invoke('session:command', cmd) as Promise<unknown>,
  sessionState: () => ipcRenderer.invoke('session:state') as Promise<unknown>,
  onAgent: (cb: (ev: unknown) => void): (() => void) => {
    const listener = (_e: unknown, ev: unknown): void => cb(ev)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  agentSend: (text: string) => ipcRenderer.invoke('agent:send', text) as Promise<unknown>,
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
  }) =>
    ipcRenderer.invoke('agent:provider-save', cfg) as Promise<{
      ok: boolean
      error?: string
      id?: string
    }>,
  agentProviderRemove: (id: string) =>
    ipcRenderer.invoke('agent:provider-remove', id) as Promise<{ ok: boolean }>,
  agentProviderActivate: (id: string) =>
    ipcRenderer.invoke('agent:provider-activate', id) as Promise<{ ok: boolean }>,
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
    cb: (req: { id: number; command: string; cwd: string; skill: string }) => void
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
  agentsAdd: (name: string, dir: string, command?: string) =>
    ipcRenderer.invoke('agents:add', name, dir, command) as Promise<{
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
  agentsSetMirrorSource: (source: 'opencode' | 'external') =>
    ipcRenderer.invoke('agents:mirror-source', source) as Promise<{ ok: boolean }>,
  agentsStop: () =>
    ipcRenderer.invoke('agents:stop') as Promise<{ ok: boolean; killed: number }>,
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
  onAgentsChildren: (cb: (count: number) => void): (() => void) => {
    const listener = (_e: unknown, n: number): void => cb(Number(n) || 0)
    ipcRenderer.on('agents:children', listener)
    return () => ipcRenderer.removeListener('agents:children', listener)
  },
  searchEngineGet: () =>
    ipcRenderer.invoke('search:engine-get') as Promise<{
      engine: string
      engines: Array<{ key: string; name: string }>
    }>,
  searchEngineSet: (engine: string) =>
    ipcRenderer.invoke('search:engine-set', engine) as Promise<{ ok: boolean }>,
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
