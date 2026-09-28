/**
 * Integration setup helpers for wiring Duplex's stdio MCP bridge into
 * external clients: Codex CLI TOML config, Claude Code add command, and a
 * Claude Desktop JSON snippet. Pure filesystem logic here so it is
 * unit-testable; UI wiring is done elsewhere.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CodexConfigStatus {
  /** Whether ~/.codex/config.toml exists. */
  found: boolean
  path: string
  /** Whether an mcp_servers.duplex section is present. */
  configured: boolean
  /** Path of the most recent backup, if any. */
  backupPath?: string
}

export interface InstallResult {
  ok: boolean
  error?: string
  backupPath?: string
}

const SECTION_HEADER = '[mcp_servers.duplex]'
const BACKUP_PREFIX = 'config.toml.bak-'

let homeOverride: string | null = null

/** Test hook: override the home directory (null = os.homedir()). */
export function __setHomeForTest(home: string | null): void {
  homeOverride = home
}

function homeDir(): string {
  return homeOverride ?? os.homedir()
}

function codexDir(): string {
  return path.join(homeDir(), '.codex')
}

function codexConfigPath(): string {
  return path.join(codexDir(), 'config.toml')
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '')
}

function readToml(): string | null {
  try {
    return stripBom(fs.readFileSync(codexConfigPath(), 'utf8'))
  } catch {
    return null
  }
}

/** Naive TOML section lookup: header line up to (excluding) the next line starting with '['. */
function findSectionRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim().startsWith(SECTION_HEADER))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('[')) {
      end = i
      break
    }
  }
  return { start, end }
}

function latestBackupPath(): string | undefined {
  try {
    const names = fs
      .readdirSync(codexDir())
      .filter((name) => name.startsWith(BACKUP_PREFIX))
      .sort()
    const last = names[names.length - 1]
    return last ? path.join(codexDir(), last) : undefined
  } catch {
    return undefined
  }
}

function formatStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

function withBackup(result: InstallResult, backupPath: string | undefined): InstallResult {
  return backupPath ? { ...result, backupPath } : result
}

export function codexConfigStatus(): CodexConfigStatus {
  const configPath = codexConfigPath()
  const raw = readToml()
  const configured = raw !== null && findSectionRange(raw.split(/\r?\n/)) !== null
  const status: CodexConfigStatus = { found: raw !== null, path: configPath, configured }
  const backupPath = latestBackupPath()
  if (backupPath) status.backupPath = backupPath
  return status
}

/**
 * Back up the existing config (if any), then write the [mcp_servers.duplex]
 * section into ~/.codex/config.toml, replacing an existing section in place.
 * Never throws: failures are reported as { ok: false, error }.
 */
export function installCodexMcp(bridgePath: string): InstallResult {
  let backupPath: string | undefined
  try {
    const configPath = codexConfigPath()
    const exists = fs.existsSync(configPath)
    let existing: string | null = null
    if (exists) {
      backupPath = `${configPath}.bak-${formatStamp(new Date())}`
      fs.copyFileSync(configPath, backupPath)
      try {
        existing = stripBom(fs.readFileSync(configPath, 'utf8'))
      } catch {
        existing = ''
      }
    }

    const newline = existing !== null && existing.includes('\r\n') ? '\r\n' : '\n'
    const lines = existing !== null ? existing.split(/\r?\n/) : []
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

    const block = [
      SECTION_HEADER,
      'command = "node"',
      `args = ["${bridgePath.replace(/\\/g, '/')}"]`
    ]
    const range = findSectionRange(lines)
    if (range) {
      lines.splice(range.start, range.end - range.start, ...block)
      const next = lines[range.start + block.length]
      if (next !== undefined && next.trimStart().startsWith('[')) {
        lines.splice(range.start + block.length, 0, '')
      }
    } else {
      if (lines.length > 0) lines.push('')
      lines.push(...block)
    }

    fs.mkdirSync(codexDir(), { recursive: true })
    fs.writeFileSync(configPath, lines.join(newline) + newline, 'utf8')

    const verify = readToml()
    if (verify === null || findSectionRange(verify.split(/\r?\n/)) === null) {
      return withBackup(
        { ok: false, error: '写入 Codex 配置后校验失败：未检测到 [mcp_servers.duplex] 段' },
        backupPath
      )
    }
    return withBackup({ ok: true }, backupPath)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return withBackup({ ok: false, error: `写入 Codex 配置失败：${message}` }, backupPath)
  }
}

/** Claude Code config command for the user to copy/run (we do not execute it). */
export function claudeMcpCommand(bridgePath: string): string {
  return `claude mcp add duplex --scope user -- node "${bridgePath}"`
}

/** JSON snippet (mcpServers form) for Claude Desktop config files. */
export function claudeDesktopConfigHint(bridgePath: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        duplex: {
          command: 'node',
          args: [bridgePath]
        }
      }
    },
    null,
    2
  )
}
