import type { ContentBounds, MirrorEvent, SessionSummary, TabInfo } from '../../shared/protocol'
import type { LlmProtocol } from '../../shared/llm'

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
    providers: Array<{
      id: string
      name: string
      baseUrl: string
      model: string
      hasKey: boolean
      protocol: LlmProtocol
      authType: 'key' | 'import'
      authSource?: 'codex' | 'opencode'
    }>
    activeId: string | null
  }>
  agentProviderSave(cfg: {
    id?: string
    name?: string
    baseUrl?: string
    apiKey?: string
    model?: string
    protocol?: string
    authType?: string
    authSource?: string
  }): Promise<{ ok: boolean; error?: string; id?: string }>
  agentProviderRemove(id: string): Promise<{ ok: boolean }>
  agentProviderActivate(id: string): Promise<{ ok: boolean }>
  agentImportOpencode(): Promise<{ ok: boolean; error?: string; added?: number }>
  agentImportStatus(source: string): Promise<{
    found: boolean
    path: string
    providers: string[]
    expiresAt?: number
    error?: string
  }>
  onAgentConfirm(
    cb: (req: { id: number; command: string; cwd: string; skill: string }) => void
  ): () => void
  agentConfirmRespond(id: number, ok: boolean): Promise<{ ok: boolean }>
  skillsList(): Promise<
    Array<{
      id: string
      name: string
      description: string
      source: 'duplex' | 'claude'
      dir: string
      enabled: boolean
    }>
  >
  skillsToggle(id: string, enabled: boolean): Promise<{ ok: boolean }>
  skillsRemove(id: string): Promise<{ ok: boolean; error?: string }>
  skillsImportFolder(): Promise<{ ok: boolean; error?: string }>
  setupCodexStatus(): Promise<{
    found: boolean
    path: string
    configured: boolean
    backupPath?: string
  }>
  setupCodexInstall(): Promise<{ ok: boolean; error?: string; backupPath?: string }>
  setupClaudeCommand(): Promise<{ command: string; hint: string; bridgeFound: boolean }>
  agentsList(): Promise<
    Array<{
      id: string
      name: string
      kind: 'opencode' | 'codex' | 'claude' | 'gemini' | 'qwen' | 'custom'
      builtin: boolean
      available: boolean
      sessionsDir?: string
      command?: string
      note?: string
    }>
  >
  agentsAdd(
    name: string,
    dir: string,
    command?: string
  ): Promise<{ ok: boolean; id?: string; error?: string }>
  agentsRemove(id: string): Promise<{ ok: boolean; error?: string }>
  agentsSessions(toolId: string): Promise<
    Array<{ id: string; title: string; updatedAt: number; file: string }>
  >
  agentsSessionOpen(
    toolId: string,
    sessionId: string,
    file: string
  ): Promise<{ ok: boolean; count?: number; title?: string; error?: string }>
  agentsSessionSend(toolId: string, message: string): Promise<{ ok: boolean; error?: string }>
  agentsModels(toolId: string): Promise<{
    current: string
    candidates: Array<{ id: string; label: string }>
  }>
  agentsModelSet(toolId: string, model: string): Promise<{ ok: boolean; error?: string }>
  agentsModelSyncGlobal(toolId: string): Promise<{
    ok: boolean
    path?: string
    backupPath?: string
    error?: string
  }>
  agentsSessionClose(): Promise<{ ok: boolean }>
  agentsSetMirrorSource(source: 'opencode' | 'external'): Promise<{ ok: boolean }>
  agentsStop(): Promise<{ ok: boolean; killed: number }>
  onAgentsChildren(cb: (count: number) => void): () => void
  emergencyKeysGet(): Promise<{ keys: string[] }>
  emergencyKeysSet(keys: string[]): Promise<{ ok: boolean; keys?: string[]; error?: string }>
  emergencyTakeover(): void
  searchEngineGet(): Promise<{ engine: string; engines: Array<{ key: string; name: string }> }>
  searchEngineSet(engine: string): Promise<{ ok: boolean }>
  agentsStartSession(
    toolId: string,
    message: string
  ): Promise<{ ok: boolean; count?: number; title?: string; error?: string }>
}

declare global {
  interface Window {
    cobrowse: CobrowseApi
  }
}

export {}
