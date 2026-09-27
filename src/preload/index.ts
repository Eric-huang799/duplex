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
  }) => ipcRenderer.invoke('agent:provider-save', cfg) as Promise<{ ok: boolean; error?: string }>,
  agentProviderRemove: (id: string) =>
    ipcRenderer.invoke('agent:provider-remove', id) as Promise<{ ok: boolean }>,
  agentProviderActivate: (id: string) =>
    ipcRenderer.invoke('agent:provider-activate', id) as Promise<{ ok: boolean }>,
  agentImportOpencode: () => ipcRenderer.invoke('agent:import-opencode') as Promise<unknown>
}

contextBridge.exposeInMainWorld('cobrowse', api)

export type CobrowsePreloadApi = typeof api
