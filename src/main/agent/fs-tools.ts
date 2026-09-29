/**
 * Filesystem/shell tools for the built-in agent, so it can run the scripts a
 * skill provides (e.g. the docx skill's python helpers, or a docx-js build
 * script it wrote itself). Every write and every command is confirmed by the
 * user through a dialog first.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { ToolResult } from '../tool-handlers'

export type FsConfirmFn = (payload: {
  kind: 'write' | 'command'
  detail: string
  cwd: string
}) => Promise<boolean>

const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] })
const errorText = (s: string): ToolResult => ({
  content: [{ type: 'text', text: s }],
  isError: true
})

/** Protected write targets — refused regardless of confirmation.
 *  Only truly dangerous areas: OS dirs and credential stores. Per-write
 *  approval is the first line of defense; this is the hard backstop.
 *  (AppData is intentionally NOT blocked: Temp lives under it.) */
function isProtectedWriteTarget(abs: string): boolean {
  const win = process.platform === 'win32'
  const home = os.homedir()
  const blocked = [
    ...(win
      ? ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)']
      : ['/etc', '/private/etc', '/usr', '/bin', '/sbin']),
    ...['.ssh', '.aws', '.gnupg'].map((d) => path.join(home, d))
  ].map((p) => (win ? p.toLowerCase() : p))
  // resolve links so junctions/symlinks into protected areas are caught
  let real = abs
  try {
    real = fs.realpathSync(abs)
  } catch {
    try {
      real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs))
    } catch {
      /* keep abs */
    }
  }
  const norm = path.resolve(real)
  const low = win ? norm.toLowerCase() : norm
  return blocked.some((p) => low === p || low.startsWith(p + path.sep))
}

export function createFsToolHandlers(
  confirm: FsConfirmFn
): Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> {
  return {
    async write_file(args) {
      const filePath = typeof args.path === 'string' ? args.path.trim() : ''
      const content = typeof args.content === 'string' ? args.content : ''
      if (!filePath) return errorText('缺少参数 path')
      if (typeof args.content !== 'string') return errorText('缺少参数 content')
      const abs = path.resolve(filePath)
      if (isProtectedWriteTarget(abs)) return errorText(`禁止写入受保护目录：${abs}`)
      const ok = await confirm({ kind: 'write', detail: abs, cwd: path.dirname(abs) })
      if (!ok) return text('用户拒绝了这次写入。')
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content, 'utf8')
        return text(`已写入 ${abs}（${Buffer.byteLength(content, 'utf8')} 字节）`)
      } catch (e) {
        return errorText(`写入失败：${(e as Error)?.message ?? String(e)}`)
      }
    },

    async run_command(args) {
      const command = typeof args.command === 'string' ? args.command.trim() : ''
      if (!command) return errorText('缺少参数 command')
      const cwd =
        typeof args.cwd === 'string' && args.cwd.trim()
          ? path.resolve(args.cwd.trim())
          : os.homedir()
      const timeoutMs = Math.min(
        Math.max(Number(args.timeout_ms ?? 120_000) || 120_000, 1000),
        600_000
      )
      const ok = await confirm({ kind: 'command', detail: command, cwd })
      if (!ok) return text('用户拒绝了这次命令执行。')
      return await new Promise<ToolResult>((resolve) => {
        const MAX_OUTPUT = 4 * 1024 * 1024
        let killTimer: ReturnType<typeof setTimeout> | null = null
        let timedOut = false
        let overflowed = false
        let settled = false
        const outChunks: Buffer[] = []
        const errChunks: Buffer[] = []
        let outBytes = 0
        let errBytes = 0

        // `exec` silently drops `detached`, so the shell child would stay in
        // our process group: killing it left grandchildren alive, holding the
        // stdout pipe open and the completion callback would never fire.
        // `spawn` honours `detached` on POSIX — the child leads its own group
        // and the timeout kill can take down the whole tree.
        const child = spawn(command, {
          cwd,
          shell: true,
          windowsHide: true,
          detached: process.platform !== 'win32'
        })

        const killTree = (): void => {
          if (!child.pid) return
          try {
            if (process.platform === 'win32') {
              spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
            } else {
              try {
                process.kill(-child.pid, 'SIGKILL')
              } catch {
                child.kill('SIGKILL')
              }
            }
          } catch {
            /* ignore */
          }
        }

        const finish = (reason: string | null): void => {
          if (settled) return
          settled = true
          if (killTimer) clearTimeout(killTimer)
          const out = `${Buffer.concat(outChunks).toString('utf8')}${
            errBytes ? `\n[stderr]\n${Buffer.concat(errChunks).toString('utf8')}` : ''
          }`
          const tail = out.length > 8000 ? `…（输出截断，保留尾部）\n${out.slice(-8000)}` : out
          if (reason) resolve(errorText(`${reason}\n${tail || '(无输出)'}`))
          else resolve(text(`命令完成（退出码 0）\n${tail || '(无输出)'}`))
        }

        const overflow = (): void => {
          if (overflowed) return
          overflowed = true
          killTree()
        }

        const collect = (chunk: Buffer, isErr: boolean): void => {
          if (isErr) {
            if (errBytes + chunk.length > MAX_OUTPUT) return overflow()
            errBytes += chunk.length
            errChunks.push(chunk)
          } else {
            if (outBytes + chunk.length > MAX_OUTPUT) return overflow()
            outBytes += chunk.length
            outChunks.push(chunk)
          }
        }

        child.stdout?.on('data', (d: Buffer) => collect(d, false))
        child.stderr?.on('data', (d: Buffer) => collect(d, true))
        child.on('error', (e) => finish(`启动失败：${e.message}`))
        child.on('close', (code, signal) => {
          if (timedOut) finish(`超时（${timeoutMs / 1000}s 限制），已终止进程`)
          else if (overflowed) finish(`输出超过 ${MAX_OUTPUT / 1024 / 1024}MB 限制，已终止进程`)
          else if (code === 0) finish(null)
          else if (code != null) finish(`退出码 ${code}`)
          else finish(`被信号终止（${signal ?? '未知'}）`)
        })
        // never leave the child waiting on stdin
        child.stdin?.end()
        killTimer = setTimeout(() => {
          timedOut = true
          killTree()
        }, timeoutMs)
      })
    }
  }
}
