/**
 * Registry of external CLI agent tools (opencode / Codex / Claude Code /
 * Gemini CLI / Qwen Code / custom additions) plus adapter logic: detection,
 * session directories, and headless start plans ("send a message from the
 * panel" → spawn a CLI in non-interactive mode).
 *
 * Built-in session formats:
 *  - codex:  ~/.codex/sessions/**\/rollout-*.jsonl        (JSONL)
 *  - claude: ~/.claude/projects/<project>/<id>.jsonl      (JSONL)
 *  - gemini: ~/.gemini/tmp/<hash>/chats/session-*.json    (single JSON)
 *  - qwen:   ~/.qwen/tmp/<hash>/chats/session-*.json      (single JSON)
 *  - custom: user-provided directory (generic JSONL/JSON)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { cobrowseDir } from '../../shared/endpoint'

export type AgentKind = 'opencode' | 'codex' | 'claude' | 'gemini' | 'qwen' | 'custom'

export interface AgentTool {
  id: string
  name: string
  kind: AgentKind
  builtin: boolean
  available: boolean
  /** Directory that holds the tool's session transcripts (when known). */
  sessionsDir?: string
  /** For custom tools: headless start command (stdin = prompt, or {prompt} placeholder). */
  command?: string
  note?: string
}

/** A resolved headless "start a new session" plan (pure data, unit-testable). */
export interface StartPlan {
  file: string
  args: string[]
  /** true = write the message to the child's stdin; false = message was inlined via {prompt}. */
  useStdin: boolean
  cwd: string
}

interface CustomAgent {
  id: string
  name: string
  sessionsDir: string
  command?: string
}

export function commandExists(cmd: string): boolean {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: 'ignore'
    })
    return r.status === 0
  } catch {
    return false
  }
}

/** Split a command line into argv segments (single/double quotes supported). */
export function splitCommandLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ' ' || ch === '\t') {
      if (cur) {
        out.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

const WIN = process.platform === 'win32'

function viaShell(cmd: string, args: string[]): { file: string; args: string[] } {
  return WIN ? { file: 'cmd.exe', args: ['/c', cmd, ...args] } : { file: cmd, args }
}

/**
 * Build the headless start plan for a tool. Built-ins know their own CLI
 * conventions; custom tools use the user-provided command template
 * (stdin by default, `{prompt}` placeholder for argument passing).
 */
export function buildStartPlan(
  tool: Pick<AgentTool, 'kind' | 'command'>,
  message: string
): StartPlan | { error: string } {
  const cwd = os.homedir()
  switch (tool.kind) {
    case 'codex':
      return { ...viaShell('codex', ['exec', '--skip-git-repo-check', '-']), useStdin: true, cwd }
    case 'claude':
      return { ...viaShell('claude', ['-p']), useStdin: true, cwd }
    case 'gemini':
      // `echo "..." | gemini` is the documented non-interactive form
      return { ...viaShell('gemini', []), useStdin: true, cwd }
    case 'qwen':
      return { ...viaShell('qwen', []), useStdin: true, cwd }
    case 'custom': {
      const line = (tool.command ?? '').trim()
      if (!line) return { error: '该自定义工具未配置启动命令（当前为只读映射）' }
      const parts = splitCommandLine(line)
      if (parts.length === 0) return { error: '启动命令无效' }
      if (parts.some((p) => p.includes('{prompt}'))) {
        // function form avoids `$&`-style replacement pattern expansion
        const filled = parts.map((p) => p.replace(/\{prompt\}/g, () => message))
        const [cmd, ...rest] = filled
        return { ...viaShell(cmd, rest), useStdin: false, cwd }
      }
      const [cmd, ...rest] = parts
      return { ...viaShell(cmd, rest), useStdin: true, cwd }
    }
    default:
      return { error: '该工具类型不支持从面板发起新会话' }
  }
}

function agentsJsonPath(): string {
  return path.join(cobrowseDir(), 'agents.json')
}

function readCustom(): CustomAgent[] {
  try {
    const raw = JSON.parse(fs.readFileSync(agentsJsonPath(), 'utf8')) as { custom?: unknown }
    if (!Array.isArray(raw.custom)) return []
    return raw.custom.filter(
      (c): c is CustomAgent =>
        !!c &&
        typeof (c as CustomAgent).id === 'string' &&
        typeof (c as CustomAgent).name === 'string' &&
        typeof (c as CustomAgent).sessionsDir === 'string'
    )
  } catch {
    return []
  }
}

function writeCustom(list: CustomAgent[]): void {
  fs.mkdirSync(cobrowseDir(), { recursive: true })
  fs.writeFileSync(agentsJsonPath(), JSON.stringify({ custom: list }, null, 2), 'utf8')
}

export function listAgentTools(): AgentTool[] {
  const home = os.homedir()
  const codexDir = path.join(home, '.codex', 'sessions')
  const claudeDir = path.join(home, '.claude', 'projects')
  const geminiDir = path.join(home, '.gemini', 'tmp')
  const qwenDir = path.join(home, '.qwen', 'tmp')
  const tools: AgentTool[] = [
    {
      id: 'opencode',
      name: 'opencode',
      kind: 'opencode',
      builtin: true,
      available: true,
      note: '双向镜像（对话 + 注入）'
    },
    {
      id: 'codex',
      name: 'Codex',
      kind: 'codex',
      builtin: true,
      available: commandExists('codex') || fs.existsSync(codexDir),
      sessionsDir: fs.existsSync(codexDir) ? codexDir : undefined,
      note: '镜像 + 可从面板发起新会话'
    },
    {
      id: 'claude',
      name: 'Claude Code',
      kind: 'claude',
      builtin: true,
      available: commandExists('claude') || fs.existsSync(claudeDir),
      sessionsDir: fs.existsSync(claudeDir) ? claudeDir : undefined,
      note: '镜像 + 可从面板发起新会话'
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      kind: 'gemini',
      builtin: true,
      available: commandExists('gemini') || fs.existsSync(geminiDir),
      sessionsDir: fs.existsSync(geminiDir) ? geminiDir : undefined,
      note: '镜像 + 可从面板发起新会话'
    },
    {
      id: 'qwen',
      name: 'Qwen Code',
      kind: 'qwen',
      builtin: true,
      available: commandExists('qwen') || fs.existsSync(qwenDir),
      sessionsDir: fs.existsSync(qwenDir) ? qwenDir : undefined,
      note: '镜像 + 可从面板发起新会话'
    }
  ]
  for (const c of readCustom()) {
    tools.push({
      id: c.id,
      name: c.name,
      kind: 'custom',
      builtin: false,
      available: fs.existsSync(c.sessionsDir),
      sessionsDir: c.sessionsDir,
      command: c.command,
      note: c.command ? '自定义（镜像 + 可发起）' : '自定义（只读映射）'
    })
  }
  return tools
}

export function addCustomAgent(
  name: string,
  sessionsDir: string,
  command?: string
): { ok: boolean; id?: string; error?: string } {
  const n = name.trim()
  const d = sessionsDir.trim()
  const cmd = (command ?? '').trim()
  if (!n) return { ok: false, error: '名称不能为空' }
  if (!d) return { ok: false, error: '会话记录目录不能为空' }
  try {
    if (!fs.statSync(d).isDirectory()) return { ok: false, error: '路径不是文件夹' }
  } catch {
    return { ok: false, error: '目录不存在：' + d }
  }
  const list = readCustom()
  const id = `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  list.push({ id, name: n, sessionsDir: d, ...(cmd ? { command: cmd } : {}) })
  try {
    writeCustom(list)
    return { ok: true, id }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? '写入失败' }
  }
}

export function removeCustomAgent(id: string): { ok: boolean; error?: string } {
  const list = readCustom()
  const next = list.filter((c) => c.id !== id)
  if (next.length === list.length) return { ok: false, error: '未找到该工具' }
  try {
    writeCustom(next)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? '写入失败' }
  }
}

export function findAgentTool(id: string): AgentTool | null {
  return listAgentTools().find((t) => t.id === id) ?? null
}
