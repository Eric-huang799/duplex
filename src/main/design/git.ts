/**
 * 设计工作区的 git 版本（只作用于调用方传入的目录）。
 *
 * 安全边界：
 *  - 所有命令都用 spawnSync + 参数数组（不经过 shell，不存在命令注入）；
 *  - 不使用 `git reset --hard` / `git push`；回退走 `git revert`（保留历史、可再回退）；
 *  - 提交身份用 `-c user.name/-c user.email` 临时指定，不依赖、也不修改用户的全局 git 配置；
 *  - 每次提交前用 `git diff --cached --quiet` 判断有没有内容，无改动直接 skipped，不造空提交。
 *
 * 关于"首次提交"：ensureRepo 会写好 .gitignore；如果目录里只有 .gitignore，
 * 不创建脚手架空提交（与 commitRound 的 skipped 语义一致）。等第一份 design.json
 * 落盘后，第一轮 commitRound 就是仓库的第一次提交——这样"第一轮 history 只有 1 条"。
 * 若目录里已经有其它内容（接管已有工作区），ensureRepo 会把它们作为初始提交快照下来。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface EnsureRepoResult {
  ok: boolean
  created?: boolean
  error?: string
}

export interface CommitRoundResult {
  ok: boolean
  sha?: string
  skipped?: boolean
  error?: string
}

export interface GitHistoryEntry {
  sha: string
  short: string
  date: string
  subject: string
}

export interface RevertResult {
  ok: boolean
  sha?: string
  error?: string
}

export interface ExportResult {
  ok: boolean
  path?: string
  error?: string
}

interface GitResult {
  ok: boolean
  status: number | null
  stdout: string
  stderr: string
}

// rounds.log 是提交后回写的本地摘要；如果纳入版本控制，每次"无改动提交"都会因它产生一个
// 只含日志的提交，所以和临时文件一样忽略。node_modules/dist/*.tmp 是任务要求的固定项。
const GITIGNORE_LINES = ['node_modules/', 'dist/', '*.tmp', 'rounds.log'] as const
const INIT_MESSAGE = '初始化设计工作区'

/** 提交身份：只作用于设计工作区这一个仓库，不读用户全局配置。 */
const IDENTITY_ARGS = [
  '-c',
  'user.name=Duplex Design',
  '-c',
  'user.email=design@duplex.invalid',
  '-c',
  'commit.gpgsign=false'
] as const

function run(dir: string, args: string[]): GitResult {
  try {
    const result = spawnSync('git', args, {
      cwd: dir,
      stdio: 'pipe',
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000
    })
    if (result.error) {
      return { ok: false, status: null, stdout: '', stderr: result.error.message }
    }
    const status = result.status
    return {
      ok: status === 0,
      status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? ''
    }
  } catch (error) {
    return { ok: false, status: null, stdout: '', stderr: (error as Error).message }
  }
}

/** 带临时身份执行写操作（commit / revert）。`-c` 必须放在子命令之前。 */
function runWithIdentity(dir: string, args: string[]): GitResult {
  return run(dir, [...IDENTITY_ARGS, ...args])
}

function clean(text: string): string {
  return text.replace(/\s+$/, '').trim()
}

function errorText(result: GitResult): string {
  return clean(result.stderr) || clean(result.stdout) || `git 退出码 ${String(result.status)}`
}

/** 环境里是否有可用的 git（单测据此 describe.skip）。 */
export function isGitAvailable(): boolean {
  try {
    const result = spawnSync('git', ['--version'], {
      stdio: 'pipe',
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000
    })
    return !result.error && result.status === 0
  } catch {
    return false
  }
}

export function isRepo(dir: string): boolean {
  return run(dir, ['rev-parse', '--git-dir']).ok
}

/** HEAD 提交 sha；仓库未初始化或还没有提交时返回 null。 */
export function headSha(dir: string): string | null {
  const result = run(dir, ['rev-parse', '--verify', 'HEAD'])
  if (!result.ok) return null
  const sha = clean(result.stdout)
  return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null
}

function ensureGitignore(dir: string): void {
  const file = path.join(dir, '.gitignore')
  let current = ''
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()))
  const missing = GITIGNORE_LINES.filter((line) => !present.has(line))
  if (missing.length === 0) return
  const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
  fs.writeFileSync(file, `${current}${separator}${missing.join('\n')}\n`, 'utf8')
}

/**
 * 确保目录是设计工作区的 git 仓库：init（若需要）+ .gitignore + 首次提交。
 * 幂等：已有仓库/已有提交时只补齐 .gitignore。
 */
export function ensureRepo(dir: string): EnsureRepoResult {
  if (!isGitAvailable()) return { ok: false, error: '找不到 git 可执行文件，无法创建版本历史' }
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { ok: false, error: `创建设计目录失败：${(error as Error).message}` }
  }

  let created = false
  if (!isRepo(dir)) {
    const init = run(dir, ['init', '-q'])
    if (!init.ok) return { ok: false, error: `git init 失败：${errorText(init)}` }
    created = true
  }

  // 设计文档按字节比较（JSON）；关掉行尾转换，避免 Windows 上 checkout 成 CRLF 后
  // 同一份文档在 git 看来"有改动"。
  run(dir, ['config', 'core.autocrlf', 'false'])

  try {
    ensureGitignore(dir)
  } catch (error) {
    return { ok: false, error: `写入 .gitignore 失败：${(error as Error).message}` }
  }

  if (!headSha(dir)) {
    const add = run(dir, ['add', '-A'])
    if (!add.ok) return { ok: false, error: `git add 失败：${errorText(add)}` }
    const staged = run(dir, ['diff', '--cached', '--name-only', '-z'])
    if (!staged.ok) return { ok: false, error: `git diff 失败：${errorText(staged)}` }
    // 只有 .gitignore 时不提交：空工作区不造空提交，第一轮提交留给 design.json。
    const content = staged.stdout.split('\0').filter((name) => name.length > 0 && name !== '.gitignore')
    if (content.length > 0) {
      const commit = runWithIdentity(dir, ['commit', '-q', '-m', INIT_MESSAGE])
      if (!commit.ok) return { ok: false, error: `初始化提交失败：${errorText(commit)}` }
    }
  }

  return { ok: true, created }
}

/** 规范化 commit message：单行、限长，避免摘要里带换行破坏 rounds.log 的一行一条。 */
function sanitizeMessage(message: string): string {
  const line = String(message ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return line || '设计更新'
}

/**
 * 提交一轮设计。无改动 → `{ ok: true, skipped: true }`（不造空提交）。
 * 调用方应先 ensureRepo；这里对未初始化目录直接报错，避免悄悄 git init 到错误位置。
 */
export function commitRound(dir: string, message: string): CommitRoundResult {
  if (!isRepo(dir)) return { ok: false, error: '设计目录尚未初始化为 Git 仓库（先调用 ensureRepo）' }
  const add = run(dir, ['add', '-A'])
  if (!add.ok) return { ok: false, error: `git add 失败：${errorText(add)}` }

  const diff = run(dir, ['diff', '--cached', '--quiet'])
  if (diff.status === 0) return { ok: true, skipped: true }
  if (diff.status !== 1) return { ok: false, error: `git diff 失败：${errorText(diff)}` }

  const commit = runWithIdentity(dir, ['commit', '-q', '-m', sanitizeMessage(message)])
  if (!commit.ok) {
    const text = `${commit.stdout}\n${commit.stderr}`
    if (/nothing to commit|no changes added/i.test(text)) return { ok: true, skipped: true }
    return { ok: false, error: `git commit 失败：${errorText(commit)}` }
  }
  const sha = headSha(dir)
  return sha ? { ok: true, sha } : { ok: false, error: '提交成功但读取 HEAD 失败' }
}

/** 最近的轮次（最新在前）。没有仓库/提交时返回空数组，让 UI 能安静地显示"还没有轮次"。 */
export function history(dir: string, limit = 20): GitHistoryEntry[] {
  if (!isRepo(dir) || !headSha(dir)) return []
  const cap = Math.max(1, Math.min(Math.floor(limit) || 20, 500))
  const log = run(dir, [
    'log',
    '-n',
    String(cap),
    '--pretty=format:%H\x1f%h\x1f%ad\x1f%s',
    '--date=iso'
  ])
  if (!log.ok) return []
  const out: GitHistoryEntry[] = []
  for (const line of log.stdout.split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    if (trimmed.length === 0) continue
    const [sha, short, date, subject] = trimmed.split('\x1f')
    if (!sha || !short) continue
    out.push({ sha, short, date: date ?? '', subject: subject ?? '' })
  }
  return out
}

/**
 * 回到某一轮：`git revert --no-edit <sha>`（不改写历史，可再次 revert 回去）。
 * 冲突/失败时执行 `git revert --abort`，避免把工作区留在 REVERT_HEAD 半完成状态。
 * **绝不 push。**
 */
export function revertTo(dir: string, sha: string): RevertResult {
  if (typeof sha !== 'string' || !/^[0-9a-f]{4,64}$/i.test(sha)) {
    return { ok: false, error: '提交哈希不合法' }
  }
  if (!isRepo(dir)) return { ok: false, error: '设计目录尚未初始化为 Git 仓库' }
  if (!headSha(dir)) return { ok: false, error: '尚未提交过任何轮次' }
  const exists = run(dir, ['cat-file', '-e', `${sha}^{commit}`])
  if (!exists.ok) return { ok: false, error: `提交不存在：${sha}` }

  const revert = runWithIdentity(dir, ['revert', '--no-edit', sha])
  if (!revert.ok) {
    runWithIdentity(dir, ['revert', '--abort'])
    return { ok: false, error: `git revert 失败：${errorText(revert)}` }
  }
  return { ok: true, sha: headSha(dir) ?? undefined }
}

/**
 * 导出最近一轮（HEAD）的 zip：`git archive --format=zip -o <target> HEAD`。
 * 从未提交过任何轮次（含只有 .gitignore 的初始化提交）→ 明确报错，不做"打包整个目录"的退化。
 */
export function exportZip(dir: string, targetPath: string): ExportResult {
  if (!isRepo(dir)) return { ok: false, error: '尚未提交过任何轮次，无法导出' }
  if (!headSha(dir)) return { ok: false, error: '尚未提交过任何轮次，无法导出' }
  // 只有 .gitignore 的仓库还没有设计文档——不算一轮。
  const hasDocument = run(dir, ['cat-file', '-e', 'HEAD:design.json'])
  if (!hasDocument.ok) return { ok: false, error: '尚未提交过任何轮次，无法导出' }

  const target = path.resolve(targetPath)
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
  } catch (error) {
    return { ok: false, error: `创建导出目录失败：${(error as Error).message}` }
  }

  const archive = run(dir, ['archive', '--format=zip', '-o', target, 'HEAD'])
  if (!archive.ok) return { ok: false, error: `git archive 失败：${errorText(archive)}` }
  try {
    if (fs.statSync(target).size === 0) return { ok: false, error: '导出的 zip 是空文件' }
  } catch (error) {
    return { ok: false, error: `导出文件不可读：${(error as Error).message}` }
  }
  return { ok: true, path: target }
}
