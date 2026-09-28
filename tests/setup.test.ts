import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
