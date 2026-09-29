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
  message: string,
  model?: string
): StartPlan | { error: string } {
  const cwd = os.homedir()
  const m = (model ?? '').trim()
  switch (tool.kind) {
    case 'codex':
      return {
        ...viaShell('codex', ['exec', '--skip-git-repo-check', ...(m ? ['-m', m] : []), '-']),
        useStdin: true,
        cwd
      }
    case 'claude':
      return {
        ...viaShell('claude', ['-p', ...(m ? ['--model', m] : [])]),
        useStdin: true,
        cwd
      }
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

/** A resolved "continue an existing session" plan (pure data, unit-testable). */
export interface ResumePlan {
  file: string
  args: string[]
  /** Working directory the CLI should resume from (the session's recorded cwd when known). */
  cwd: string
}

/**
 * Build the headless resume plan for tools whose CLIs can continue a recorded
 * session (Codex `exec resume`, Claude Code `--resume`). The message is always
 * delivered over stdin (`-` / bare `-p`), which avoids argv quoting issues.
 */
export function buildResumePlan(
  tool: Pick<AgentTool, 'kind'>,
  cliSessionId: string,
  cwdHint: string,
  model?: string
): ResumePlan | { error: string } {
  const id = cliSessionId.trim()
  if (!id) return { error: '无法确定该会话的 CLI 会话 ID' }
  const m = (model ?? '').trim()
  let cwd = os.homedir()
  if (cwdHint) {
    try {
      if (fs.statSync(cwdHint).isDirectory()) cwd = cwdHint
    } catch {
      /* fall back to home */
    }
  }
  switch (tool.kind) {
    case 'codex':
      return {
        ...viaShell('codex', ['exec', 'resume', '--skip-git-repo-check', ...(m ? ['-m', m] : []), id, '-']),
        cwd
      }
    case 'claude':
      return { ...viaShell('claude', ['--resume', id, '-p', ...(m ? ['--model', m] : [])]), cwd }
    default:
      return { error: '该工具暂不支持从面板续聊，可发起新会话或在原 CLI 中继续' }
  }
}

function agentsJsonPath(): string {
  return path.join(cobrowseDir(), 'agents.json')
}

interface AgentsFile {
  custom?: CustomAgent[]
  /** Per-tool model used when the panel launches/resumes a session ('' = follow CLI config). */
  models?: Record<string, string>
}

function readAgentsFile(): AgentsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(agentsJsonPath(), 'utf8')) as AgentsFile
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeAgentsFile(file: AgentsFile): void {
  fs.mkdirSync(cobrowseDir(), { recursive: true })
  fs.writeFileSync(agentsJsonPath(), JSON.stringify(file, null, 2), 'utf8')
}

function readCustom(): CustomAgent[] {
  const list = readAgentsFile().custom
  if (!Array.isArray(list)) return []
  return list.filter(
    (c): c is CustomAgent =>
      !!c &&
      typeof (c as CustomAgent).id === 'string' &&
      typeof (c as CustomAgent).name === 'string' &&
      typeof (c as CustomAgent).sessionsDir === 'string'
  )
}

function writeCustom(list: CustomAgent[]): void {
  const file = readAgentsFile()
  file.custom = list
  writeAgentsFile(file)
}

/** Per-tool model used when the panel launches or resumes a session ('' = CLI default). */
export function getToolModel(toolId: string): string {
  const v = readAgentsFile().models?.[toolId]
  return typeof v === 'string' ? v : ''
}

export function setToolModel(toolId: string, model: string): { ok: boolean; error?: string } {
  const file = readAgentsFile()
  const models = { ...(file.models ?? {}) }
  const m = model.trim()
  if (m) models[toolId] = m
  else delete models[toolId]
  file.models = models
  try {
    writeAgentsFile(file)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? '写入失败' }
  }
}

/** Candidate models read from the tool's own config files (codex models cache / claude settings). */
export function listCandidateModels(
  tool: Pick<AgentTool, 'kind'>
): Array<{ id: string; label: string }> {
  const home = os.homedir()
  try {
    if (tool.kind === 'codex') {
      const raw = JSON.parse(
        fs.readFileSync(path.join(home, '.codex', 'models_cache.json'), 'utf8')
      ) as { models?: unknown }
      if (!Array.isArray(raw.models)) return []
      const out: Array<{ id: string; label: string }> = []
      for (const entry of raw.models) {
        const slug = (entry as { slug?: unknown })?.slug
        if (typeof slug !== 'string' || !slug.trim()) continue
        const display = (entry as { display_name?: unknown })?.display_name
        out.push({
          id: slug.trim(),
          label: typeof display === 'string' && display.trim() ? display.trim() : slug.trim()
        })
      }
      return out
    }
    if (tool.kind === 'claude') {
      const raw = JSON.parse(
        fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')
      ) as { env?: Record<string, unknown>; model?: unknown }
      const set = new Set<string>()
      for (const key of [
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'CLAUDE_CODE_SUBAGENT_MODEL'
      ]) {
        const v = raw.env?.[key]
        if (typeof v === 'string' && v.trim()) set.add(v.trim())
      }
      if (typeof raw.model === 'string' && raw.model.trim()) set.add(raw.model.trim())
      return [...set].map((id) => ({ id, label: id }))
    }
  } catch {
    /* no candidates available */
  }
  return []
}

/** Pure TOML edit: replace (or insert) the top-level `model = "..."` line, leaving [tables] alone. */
export function setTomlModel(content: string, model: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  const line = `model = ${JSON.stringify(model)}`
  let replaced = false
  let inTable = false
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.startsWith('[')) inTable = true
    if (!inTable && /^model\s*=/.test(t)) {
      lines[i] = line
      replaced = true
      break
    }
  }
  if (!replaced) {
    let idx = lines.findIndex((l) => l.trim().startsWith('['))
    if (idx < 0) idx = lines.length
    lines.splice(idx, 0, line)
  }
  return lines.join(eol)
}

/** Pure settings.json edit: set the top-level "model" field, preserving every other key. */
export function setJsonModel(content: string, model: string): string {
  const obj = JSON.parse(content) as Record<string, unknown>
  obj.model = model
  return JSON.stringify(obj, null, 2) + '\n'
}

/** Write the panel-selected model into the tool's global CLI config (timestamped backup first). */
export function syncModelToGlobal(
  tool: Pick<AgentTool, 'kind'>,
  model: string
): { ok: boolean; path?: string; backupPath?: string; error?: string } {
  const m = model.trim()
  if (!m) return { ok: false, error: '请先在面板中选择一个模型，再同步到全局' }
  const home = os.homedir()
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const apply = (
    file: string,
    edit: (content: string) => string
  ): { ok: boolean; path?: string; backupPath?: string; error?: string } => {
    if (!fs.existsSync(file)) return { ok: false, error: '未找到配置文件：' + file }
    try {
      const content = fs.readFileSync(file, 'utf8')
      const next = edit(content)
      const backupPath = `${file}.bak-${stamp}`
      fs.copyFileSync(file, backupPath)
      fs.writeFileSync(file, next, 'utf8')
      return { ok: true, path: file, backupPath }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? '写入失败' }
    }
  }
  if (tool.kind === 'codex') {
    return apply(path.join(home, '.codex', 'config.toml'), (c) => setTomlModel(c, m))
  }
  if (tool.kind === 'claude') {
    return apply(path.join(home, '.claude', 'settings.json'), (c) => setJsonModel(c, m))
  }
  return { ok: false, error: '该工具不支持写回全局配置' }
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
      note: '镜像 + 可从面板续聊'
    },
    {
      id: 'claude',
      name: 'Claude Code',
      kind: 'claude',
      builtin: true,
      available: commandExists('claude') || fs.existsSync(claudeDir),
      sessionsDir: fs.existsSync(claudeDir) ? claudeDir : undefined,
      note: '镜像 + 可从面板续聊'
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
