import type { BrowserDataSnapshot, ChatSendResult, ContentBounds, DownloadRecord, LoadErrorInfo, MirrorEvent, SessionSummary, TabInfo } from '../../shared/protocol'
import type { LlmProtocol } from '../../shared/llm'

interface CobrowseApi {
  ready(): Promise<{ tabs: TabInfo[]; activeTabId: number | null; mirror: MirrorEvent[] }>
  onTabs(cb: (tabs: TabInfo[], activeTabId: number | null) => void): () => void
  onBrowserShortcut(cb: (action: string) => void): () => void
  getPlatform(): string
  onFindResult(cb: (r: { matches: number; activeMatch: number }) => void): () => void
  showTabContextMenu(tabId: number, x: number, y: number): void
  showEngineMenu(x: number, y: number): void
  showToolsMenu(
    x: number,
    y: number,
    state: { annotationActive: boolean; theme: string }
  ): void
  onSearchEngineChanged(cb: (engine: string) => void): () => void
  onThemeChanged(cb: (theme: 'system' | 'light' | 'dark') => void): () => void
  downloadConfirmGet(): Promise<{ enabled: boolean }>
  downloadConfirmSet(enabled: boolean): Promise<{ ok: boolean; error?: string }>
  shortcutsGet(): Promise<{ shortcuts: Record<string, string>; defaults: Record<string, string> }>
  shortcutsSet(partial: Record<string, string | null>): Promise<{
    ok: boolean
    error?: string
    shortcuts?: Record<string, string>
  }>
  onShortcutsChanged(cb: (map: Record<string, string>) => void): () => void
  bookmarkAdd(record: {
    url: string
    title: string
    favicon?: string
    folder?: string
  }): Promise<{ ok: boolean; error?: string }>
  bookmarkUpdate(
    url: string,
    patch: { title?: string; url?: string; folder?: string }
  ): Promise<{ ok: boolean; error?: string }>
  bookmarkRemove(url: string): Promise<{ ok: boolean }>
  bookmarkFolderAdd(name: string): Promise<{ ok: boolean; error?: string }>
  bookmarkFolderRemove(name: string): Promise<{ ok: boolean }>
  bookmarkFolderRename(oldName: string, newName: string): Promise<{ ok: boolean; error?: string }>
  onLoadError(cb: (info: LoadErrorInfo) => void): () => void
  setPanelMode(mode: 'opencode' | 'agent' | 'external'): Promise<{ ok: boolean }>
  onMirror(cb: (ev: MirrorEvent) => void): () => void
  setContentBounds(b: ContentBounds): void
  setChromeOverlay(id: string, open: boolean): void
  tabAction(a: { type: string; url?: string; tabId?: number; value?: number }): Promise<unknown>
  browserData(): Promise<BrowserDataSnapshot>
  onBrowserData(cb: (data: BrowserDataSnapshot) => void): () => void
  bookmarkToggle(record: { url: string; title: string; favicon?: string }): Promise<{ bookmarked: boolean }>
  historyRemove(url: string, visitedAt: number): Promise<{ ok: boolean }>
  historyClear(): Promise<{ ok: boolean }>
  downloadsList(): Promise<DownloadRecord[]>
  downloadsCancel(id: string): Promise<{ ok: boolean }>
  downloadsClear(): Promise<{ ok: boolean }>
  downloadsOpen(id: string): Promise<{ ok: boolean; error?: string }>
  downloadsReveal(id: string): Promise<{ ok: boolean; error?: string }>
  onDownloads(cb: (rows: DownloadRecord[]) => void): () => void
  sendChat(text: string): Promise<ChatSendResult>
  annotationToggle(): Promise<{ ok: boolean; active: boolean }>
  onAnnotationState(cb: (active: boolean) => void): () => void
  getTheme(): Promise<{ theme: 'system' | 'light' | 'dark' }>
  setTheme(theme: 'system' | 'light' | 'dark'): Promise<{ ok: boolean; theme?: string; error?: string }>
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
      allowCustomHost?: boolean
      idleTimeoutMs?: number
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
    allowCustomHost?: boolean
    idleTimeoutMs?: number
    clearApiKey?: boolean
  }): Promise<{ ok: boolean; error?: string; id?: string }>
  agentProviderRemove(id: string): Promise<{ ok: boolean; error?: string }>
  agentProviderActivate(id: string): Promise<{ ok: boolean; error?: string }>
  agentImportOpencode(): Promise<{ ok: boolean; error?: string; added?: number }>
  agentImportStatus(source: string): Promise<{
    found: boolean
    path: string
    providers: string[]
    expiresAt?: number
    error?: string
  }>
  onAgentConfirm(
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
    command?: string,
    cwd?: string
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
  agentsStop(toolId?: string): Promise<{ ok: boolean; killed: number }>
  onAgentsChildren(cb: (count: number) => void): () => void
  onAgentsWatchError(cb: (s: { toolId: string; error: string }) => void): () => void
  emergencyKeysGet(): Promise<{ keys: string[] }>
  emergencyKeysSet(keys: string[]): Promise<{ ok: boolean; keys?: string[]; error?: string }>
  emergencyTakeover(): void
  resumeAi(): void
  onEmergencyState(cb: (s: { paused: boolean }) => void): () => void
  onEmergencyStop(
    cb: (s: { via?: string; aborted?: boolean; killed?: number; dropped?: number }) => void
  ): () => void
  onAgentConfirmCancel(cb: (s: { id?: number }) => void): () => void
  searchEngineGet(): Promise<{ engine: string; engines: Array<{ key: string; name: string }> }>
  searchEngineSet(engine: string): Promise<{ ok: boolean; error?: string }>
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
