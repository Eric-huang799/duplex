/**
 * 原子写：`tmp → fsync → rename`（可选再 fsync 目录）。
 *
 * 全仓的 store 原来只做了 `tmp + rename`：rename 本身是原子的，但**数据页可能
 * 还留在 OS 缓存里**，断电/蓝屏会留下"文件在、内容不全"。写 token、密钥这类文件
 * 时必须把 fsync 补上；同时给权限位留口子（POSIX 下 0600，Windows 走 ACL）。
 */
import fs from 'node:fs'
import path from 'node:path'

export interface AtomicWriteOptions {
  /** POSIX 权限位，默认 0o600（这些文件常含凭据）。Windows 上忽略。 */
  mode?: number
  /** 是否 fsync 父目录让 rename 本身也落盘，默认 true。 */
  syncDirectory?: boolean
}

export function writeFileAtomic(file: string, data: string, options: AtomicWriteOptions = {}): void {
  const mode = options.mode ?? 0o600
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}-${Date.now().toString(36)}.tmp`)
  let fd: number | null = null
  try {
    fd = fs.openSync(tmp, 'w', mode)
    fs.writeSync(fd, data)
    // 先落数据再 rename：否则崩溃后可能 rename 成功但内容为空
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file)
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* nothing was written */
    }
    throw error
  }
  if (options.syncDirectory === false) return
  try {
    const dirFd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(dirFd)
    } finally {
      fs.closeSync(dirFd)
    }
  } catch {
    /* Windows 不支持对目录 fsync —— 静默跳过 */
  }
}
