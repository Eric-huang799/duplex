/**
 * Tool handlers that expose the skill system to the built-in agent:
 * read_skill, list_skill_files, read_skill_file and run_skill_script.
 *
 * Script execution always asks the user for confirmation first; the command
 * is assembled as an argv array (never through a shell) and runs with the
 * skill directory as cwd.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawnSync, type ChildProcess } from 'node:child_process'
import type { ToolResult } from '../tool-handlers'
import { duplexShimEnv, ensureOpenShim } from '../open-shim'
import { interruptibleAwait, operationSignal } from '../interrupt'
import { listSkillFiles, listSkills, readSkillFile, readSkillMarkdown } from './skills'

export type ScriptConfirmFn = (payload: {
  command: string
  cwd: string
  skill: string
  tool?: string
  kind?: 'script'
  /** Script content preview (at most 2000 chars, truncated marker included). */
  preview?: string
}) => Promise<boolean>

const SCRIPT_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 8000
const MAX_BUFFER = 8 * 1024 * 1024
const PREVIEW_LIMIT = 2000

/** A ≤2000-char preview with an explicit truncation marker. */
function contentPreview(content: string): string {
  if (content.length <= PREVIEW_LIMIT) return content
  const suffix = '\n…（内容已截断）'
  return content.slice(0, PREVIEW_LIMIT - suffix.length) + suffix
}

const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] })
const errorText = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }], isError: true })

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** Look up by exact id first, then by the first matching name. */
function findSkill(idOrName: string) {
  const all = listSkills()
  return all.find((s) => s.id === idOrName) ?? all.find((s) => s.name === idOrName) ?? null
}

/** Resolve a relative path inside dir; returns null when it escapes the dir. */
function resolveInside(dir: string, relPath: string): string | null {
  try {
    if (typeof relPath !== 'string' || relPath.trim().length === 0) return null
    if (path.isAbsolute(relPath)) return null
    const base = path.resolve(dir)
    const target = path.resolve(base, relPath)
    if (target === base) return null
    if (!target.startsWith(base + path.sep)) return null
    return target
  } catch {
    return null
  }
}

interface ScriptRuntime {
  bin: string
  args: (scriptPath: string, scriptArgs: string[]) => string[]
}

function runtimeFor(scriptPath: string): ScriptRuntime | null {
  switch (path.extname(scriptPath).toLowerCase()) {
    case '.ps1':
      return {
        bin: 'powershell',
        args: (p, a) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p, ...a]
      }
    case '.py':
      return { bin: 'python', args: (p, a) => [p, ...a] }
    case '.js':
    case '.mjs':
    case '.cjs':
      return { bin: 'node', args: (p, a) => [p, ...a] }
    case '.cmd':
    case '.bat':
      return { bin: 'cmd', args: (p, a) => ['/c', p, ...a] }
    default:
      return null
  }
}

function quoteArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

function truncateOutput(s: string): string {
  return s.length <= OUTPUT_LIMIT ? s : `${s.slice(0, OUTPUT_LIMIT)}\n...(输出已截断)`
}

/** Kill a script child together with its descendants (Windows: taskkill /T). */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    /* ignore */
  }
}

function executeScript(bin: string, execArgs: string[], cwd: string): Promise<ToolResult> {
  return new Promise((resolve) => {
    try {
      const opSignal = operationSignal()
      let settled = false
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (r: ToolResult): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        opSignal?.removeEventListener('abort', onAbort)
        resolve(r)
      }
      const onAbort = (): void => {
        killTree(child)
        finish(errorText('已被用户急停中断（脚本已终止）'))
      }
      const child = execFile(
        bin,
        execArgs,
        {
          cwd,
          windowsHide: true,
          maxBuffer: MAX_BUFFER,
          encoding: 'utf8',
          // FB-001: scripts that open a browser should land in Duplex
          env: duplexShimEnv(ensureOpenShim())
        },
        (error, stdout, stderr) => {
          const output = truncateOutput(`${stdout ?? ''}${stderr ?? ''}`)
          if (timedOut) {
            finish(errorText(`脚本执行超时（${SCRIPT_TIMEOUT_MS / 1000} 秒）\n${output}`))
            return
          }
          if (error) {
            const code = typeof error.code === 'number' ? error.code : -1
            finish(errorText(`exit code: ${code}\n${output}`))
            return
          }
          finish(text(`exit code: 0\n${output}`))
        }
      )
      timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, SCRIPT_TIMEOUT_MS)
      if (opSignal) {
        if (opSignal.aborted) onAbort()
        else opSignal.addEventListener('abort', onAbort, { once: true })
      }
    } catch (err) {
      resolve(errorText(`执行脚本失败：${err instanceof Error ? err.message : String(err)}`))
    }
  })
}

export function createSkillToolHandlers(
  confirm: ScriptConfirmFn
): Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> {
  return {
    async read_skill(args: Record<string, unknown>): Promise<ToolResult> {
      const name = stringArg(args, 'name')
      if (!name) return errorText('缺少参数 name')
      const skill = findSkill(name)
      if (!skill) return errorText(`未找到 skill：${name}`)
      const result = readSkillMarkdown(skill.id)
      if (!result.ok || result.content === undefined) {
        return errorText(result.error ?? `读取失败：${skill.id}`)
      }
      return text(`Skill: ${skill.id}\nDirectory: ${skill.dir}\n\n${result.content}`)
    },

    async list_skill_files(args: Record<string, unknown>): Promise<ToolResult> {
      const name = stringArg(args, 'name')
      if (!name) return errorText('缺少参数 name')
      const skill = findSkill(name)
      if (!skill) return errorText(`未找到 skill：${name}`)
      const result = listSkillFiles(skill.id)
      if (!result.ok || !result.files) return errorText(result.error ?? `列出文件失败：${skill.id}`)
      return text(`Files in ${skill.id}:\n${result.files.join('\n')}`)
    },

    async read_skill_file(args: Record<string, unknown>): Promise<ToolResult> {
      const name = stringArg(args, 'name')
      if (!name) return errorText('缺少参数 name')
      const relPath = stringArg(args, 'path')
      if (!relPath) return errorText('缺少参数 path')
      const skill = findSkill(name)
      if (!skill) return errorText(`未找到 skill：${name}`)
      const result = readSkillFile(skill.id, relPath)
      if (!result.ok || result.content === undefined) {
        return errorText(result.error ?? `读取文件失败：${relPath}`)
      }
      return text(result.content)
    },

    async run_skill_script(args: Record<string, unknown>): Promise<ToolResult> {
      const name = stringArg(args, 'name')
      if (!name) return errorText('缺少参数 name')
      const scriptRel = stringArg(args, 'script')
      if (!scriptRel) return errorText('缺少参数 script')
      const skill = findSkill(name)
      if (!skill) return errorText(`未找到 skill：${name}`)

      const scriptPath = resolveInside(skill.dir, scriptRel)
      if (!scriptPath) return errorText(`非法脚本路径（超出 skill 目录）：${scriptRel}`)
      if (!fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
        return errorText(`脚本不存在：${scriptRel}`)
      }
      const runtime = runtimeFor(scriptPath)
      if (!runtime) {
        return errorText(`不支持的脚本类型：${path.extname(scriptPath) || scriptRel}`)
      }

      const scriptArgs = Array.isArray(args.args) ? args.args.map((a) => String(a)) : []
      const execArgs = runtime.args(scriptPath, scriptArgs)
      const command = [runtime.bin, ...execArgs].map(quoteArg).join(' ')

      let preview: string | undefined
      try {
        preview = contentPreview(fs.readFileSync(scriptPath, 'utf8'))
      } catch {
        /* preview is best-effort; the command is still shown */
      }

      let approved = false
      try {
        approved = await interruptibleAwait(
          confirm({
            command,
            cwd: skill.dir,
            skill: skill.id,
            tool: 'run_skill_script',
            kind: 'script',
            preview
          }),
          false
        )
      } catch {
        approved = false
      }
      if (!approved) {
        return operationSignal()?.aborted
          ? text('已被用户急停中断（脚本未执行）')
          : text('用户拒绝执行该脚本')
      }

      return await executeScript(runtime.bin, execArgs, skill.dir)
    }
  }
}
