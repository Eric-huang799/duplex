import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  __setHomeForTest,
  claudeDesktopConfigHint,
  claudeMcpCommand,
  codexConfigStatus,
  installCodexMcp
} from '../src/main/integrations/setup'
import {
  activeAgentConfig,
  loadSettings,
  saveAiPaused,
  saveConfirmBeforeDownload,
  saveProviders,
  saveSearchEngine,
  saveTheme
} from '../src/main/settings'
import type { AgentProvider } from '../src/main/agent/providers'
import { BrowserDataStore } from '../src/main/browser-data'

const BRIDGE = path.join(os.tmpdir(), 'duplex-bridge-test', 'index.cjs')
const BRIDGE_TOML = BRIDGE.replace(/\\/g, '/')

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-setup-'))
  __setHomeForTest(home)
})

afterEach(() => {
  __setHomeForTest(null)
  fs.rmSync(home, { recursive: true, force: true })
})

function configPath(): string {
  return path.join(home, '.codex', 'config.toml')
}

function writeConfig(content: string): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), content, 'utf8')
}

function readConfig(): string {
  return fs.readFileSync(configPath(), 'utf8')
}

describe('codexConfigStatus / installCodexMcp', () => {
  it('reports not found, then installs into a fresh home', () => {
    const before = codexConfigStatus()
    expect(before.found).toBe(false)
    expect(before.configured).toBe(false)
    expect(before.path).toBe(configPath())
    expect(before.backupPath).toBeUndefined()

    const result = installCodexMcp(BRIDGE)
    expect(result.ok).toBe(true)
    expect(result.backupPath).toBeUndefined()
    expect(fs.existsSync(configPath())).toBe(true)

    const after = codexConfigStatus()
    expect(after.found).toBe(true)
    expect(after.configured).toBe(true)

    const text = readConfig()
    expect(text).toContain('[mcp_servers.duplex]')
    expect(text).toContain('command = "node"')
    expect(text).toContain(`args = ["${BRIDGE_TOML}"]`)
  })

  it('keeps unrelated content and appends the duplex section', () => {
    const original = [
      'model = "gpt-5"',
      '',
      '[model_providers.custom]',
      'name = "Custom"',
      ''
    ].join('\n')
    writeConfig(original)

    const result = installCodexMcp(BRIDGE)
    expect(result.ok).toBe(true)
    expect(result.backupPath).toBeDefined()
    expect(path.basename(result.backupPath!)).toMatch(/^config\.toml\.bak-\d{8}-\d{6}$/)
    expect(fs.readFileSync(result.backupPath!, 'utf8')).toBe(original)

    const text = readConfig()
    expect(text).toContain('model = "gpt-5"')
    expect(text).toContain('[model_providers.custom]')
    expect(text).toContain('name = "Custom"')
    expect(text.match(/\[mcp_servers\.duplex\]/g)).toHaveLength(1)
    expect(text.indexOf('[model_providers.custom]')).toBeLessThan(
      text.indexOf('[mcp_servers.duplex]')
    )

    const status = codexConfigStatus()
    expect(status.configured).toBe(true)
    expect(status.backupPath).toBe(result.backupPath)
  })

  it('replaces an existing duplex section in place without duplicating it', () => {
    const oldBridge = 'C:/old/bridge.cjs'
    writeConfig(
      [
        '[model_providers.custom]',
        'name = "Custom"',
        '',
        '[mcp_servers.duplex]',
        'command = "node"',
        `args = ["${oldBridge}"]`,
        '',
        '[mcp_servers.other]',
        'command = "foo"',
        ''
      ].join('\n')
    )

    const result = installCodexMcp(BRIDGE)
    expect(result.ok).toBe(true)
    expect(result.backupPath).toBeDefined()
    expect(fs.existsSync(result.backupPath!)).toBe(true)

    const text = readConfig()
    expect(text.match(/\[mcp_servers\.duplex\]/g)).toHaveLength(1)
    expect(text).not.toContain(oldBridge)
    expect(text).toContain(`args = ["${BRIDGE_TOML}"]`)
    expect(text).toContain('[model_providers.custom]')
    expect(text).toContain('[mcp_servers.other]')
    expect(text).toContain('command = "foo"')
    expect(text.indexOf('[model_providers.custom]')).toBeLessThan(
      text.indexOf('[mcp_servers.duplex]')
    )
  })

  it('fails without throwing when the config cannot be written', () => {
    const blockedHome = path.join(home, 'blocked')
    fs.writeFileSync(blockedHome, 'not a directory', 'utf8')
    __setHomeForTest(blockedHome)

    const result = installCodexMcp(BRIDGE)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(() => codexConfigStatus()).not.toThrow()
  })
})

describe('claude helpers', () => {
  it('builds the Claude Code add command with the raw bridge path', () => {
    const cmd = claudeMcpCommand(BRIDGE)
    expect(cmd).toContain('node')
    expect(cmd).toContain(BRIDGE)
    expect(cmd).toBe(`claude mcp add duplex --scope user -- node "${BRIDGE}"`)
  })

  it('returns a valid mcpServers JSON snippet for Claude Desktop', () => {
    const parsed = JSON.parse(claudeDesktopConfigHint(BRIDGE)) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(parsed.mcpServers.duplex.command).toBe('node')
    expect(parsed.mcpServers.duplex.args).toEqual([BRIDGE])
  })
})

describe('settings persistence (atomic writes + backup recovery)', () => {
  let dataDir = ''
  let originalDataDir: string | undefined

  beforeEach(() => {
    originalDataDir = process.env.DUPLEX_DATA_DIR
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-settings-'))
    process.env.DUPLEX_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DUPLEX_DATA_DIR
    else process.env.DUPLEX_DATA_DIR = originalDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  function settingsFile(): string {
    return path.join(dataDir, 'settings.json')
  }

  it('defaults stop keys / confirmBeforeDownload with a fresh module and no config', async () => {
    vi.resetModules()
    const settings = await import('../src/main/settings')
    const s = settings.loadSettings()
    expect(s.emergencyStopKeys).toEqual(['F2', 'Ctrl+Shift+K'])
    expect(s.confirmBeforeDownload).toBe(true)
    expect(s.aiPaused).toBe(false)
    expect(settings.activeAgentConfig()).toBeNull()
  })

  it('save* returns {ok} and keeps a .bak of the previous file', () => {
    const r1 = saveTheme('dark')
    expect(r1.ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).theme).toBe('dark')
    expect(fs.existsSync(`${settingsFile()}.bak`)).toBe(false)

    const r2 = saveSearchEngine('bing')
    expect(r2.ok).toBe(true)
    expect(fs.existsSync(`${settingsFile()}.bak`)).toBe(true)
    expect(JSON.parse(fs.readFileSync(`${settingsFile()}.bak`, 'utf8')).theme).toBe('dark')
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).searchEngine).toBe('bing')
    expect(fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toHaveLength(0)
  })

  it('recovers a corrupt settings.json from .bak instead of overwriting with {}', () => {
    fs.writeFileSync(settingsFile(), '{not json', 'utf8')
    fs.writeFileSync(
      `${settingsFile()}.bak`,
      JSON.stringify({ theme: 'light', searchEngine: 'google' }),
      'utf8'
    )
    const r = saveTheme('dark')
    expect(r.ok).toBe(true)
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>
    expect(saved.theme).toBe('dark')
    expect(saved.searchEngine).toBe('google')
  })

  it('fails without touching the file when settings.json is corrupt and .bak is unusable', () => {
    fs.writeFileSync(settingsFile(), '{not json', 'utf8')
    const r = saveTheme('light')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('设置')
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{not json')
  })

  it('persists confirmBeforeDownload and aiPaused', () => {
    expect(saveConfirmBeforeDownload(false).ok).toBe(true)
    expect(saveAiPaused(true).ok).toBe(true)
    const s = loadSettings()
    expect(s.confirmBeforeDownload).toBe(false)
    expect(s.aiPaused).toBe(true)
  })

  it('accepts stop keys up to 32 chars and ignores longer ones when loading', () => {
    const tooLong = 'Ctrl+' + 'A'.repeat(40)
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ emergencyStopKeys: [tooLong, 'F9'] }),
      'utf8'
    )
    const s = loadSettings()
    expect(s.emergencyStopKeys).toEqual(['F9'])
  })

  it('round-trips provider passthrough fields through save and load', () => {
    const providers: AgentProvider[] = [
      {
        id: 'p1',
        name: 'x',
        baseUrl: 'https://x.example/v1',
        apiKey: 'sk-test',
        model: 'm',
        protocol: 'openai-chat',
        authType: 'key',
        allowCustomHost: true,
        idleTimeoutMs: 30000
      }
    ]
    const r = saveProviders(providers, 'p1')
    expect(r.ok).toBe(true)
    const s = loadSettings()
    expect(s.agentProviders[0].allowCustomHost).toBe(true)
    expect(s.agentProviders[0].idleTimeoutMs).toBe(30000)
  })
})

describe('BrowserDataStore (debounced history persistence)', () => {
  let dir = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-bd-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function readData(d: string): { history: Array<{ url: string }> } {
    return JSON.parse(fs.readFileSync(path.join(d, 'browser-data.json'), 'utf8')) as {
      history: Array<{ url: string }>
    }
  }

  it('writes history asynchronously after the debounce window', async () => {
    const store = new BrowserDataStore(dir)
    store.addHistory({ url: 'https://a.example/', title: 'A', visitedAt: 1 })
    expect(fs.existsSync(path.join(dir, 'browser-data.json'))).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 800))
    const data = readData(dir)
    expect(data.history.map((h) => h.url)).toEqual(['https://a.example/'])
  })

  it('clears history immediately, keeps a .bak of the previous file, and discards pending writes', async () => {
    fs.writeFileSync(
      path.join(dir, 'browser-data.json'),
      JSON.stringify({ bookmarks: [], history: [{ url: 'https://old.example/', title: 'o', visitedAt: 1 }], downloads: [] }),
      'utf8'
    )
    const store = new BrowserDataStore(dir)
    store.addHistory({ url: 'https://new.example/', title: 'n', visitedAt: 2 })
    store.clearHistory()
    expect(readData(dir).history).toEqual([])
    const bak = JSON.parse(
      fs.readFileSync(path.join(dir, 'browser-data.json.bak'), 'utf8')
    ) as { history: Array<{ url: string }> }
    expect(bak.history.map((h) => h.url)).toEqual(['https://old.example/'])
    await new Promise((resolve) => setTimeout(resolve, 700))
    // the pending debounced write must not resurrect the cleared entry
    expect(readData(dir).history).toEqual([])
  })
})
