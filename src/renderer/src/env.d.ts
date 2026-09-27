import type { ContentBounds, MirrorEvent, SessionSummary, TabInfo } from '../../shared/protocol'

interface CobrowseApi {
  ready(): Promise<{ tabs: TabInfo[]; activeTabId: number | null; mirror: MirrorEvent[] }>
  onTabs(cb: (tabs: TabInfo[], activeTabId: number | null) => void): () => void
  onMirror(cb: (ev: MirrorEvent) => void): () => void
  setContentBounds(b: ContentBounds): void
  tabAction(a: { type: string; url?: string; tabId?: number }): Promise<unknown>
  sendChat(text: string): Promise<unknown>
  getTheme(): Promise<{ theme: 'system' | 'light' | 'dark' }>
  setTheme(theme: 'system' | 'light' | 'dark'): Promise<{ ok: boolean; theme: string }>
  sessionCommand(cmd: { action: string; sessionID?: string | null; title?: string }): Promise<unknown>
  sessionState(): Promise<{
    activeSessionID: string | null
    activeTitle: string | null
    sessions: SessionSummary[]
  }>
  onAgent(cb: (ev: MirrorEvent & { info?: string }) => void): () => void
  agentSend(text: string): Promise<{ ok: boolean; error?: string }>
  agentAbort(): Promise<unknown>
  agentReset(): Promise<unknown>
  agentNewSession(): Promise<{ ok: boolean; error?: string }>
  agentSessions(): Promise<Array<{ id: string; title: string; updatedAt: number; current: boolean }>>
  agentSwitchSession(id: string): Promise<{ ok: boolean; error?: string }>
  agentDeleteSession(id: string): Promise<{ ok: boolean; error?: string }>
  agentEvents(): Promise<Array<MirrorEvent & { info?: string }>>
  agentProviders(): Promise<{
    providers: Array<{ id: string; name: string; baseUrl: string; model: string; hasKey: boolean }>
    activeId: string | null
  }>
  agentProviderSave(cfg: {
    id?: string
    name?: string
    baseUrl?: string
    apiKey?: string
    model?: string
  }): Promise<{ ok: boolean; error?: string; id?: string }>
  agentProviderRemove(id: string): Promise<{ ok: boolean }>
  agentProviderActivate(id: string): Promise<{ ok: boolean }>
  agentImportOpencode(): Promise<{ ok: boolean; error?: string; added?: number }>
}

declare global {
  interface Window {
    cobrowse: CobrowseApi
  }
}

export {}
