/**
 * 给"AI 改过的设置"留一份可回滚的快照。
 *
 * 为什么需要：AI 现在能直接调整用户的浏览器设置（广告拦截等）。能力越大越需要退路——
 * 一旦它把某个开关调坏、或用户只是不认同这次改动，必须有一条**简单可信的撤销路径**，
 * 而不是让用户自己去翻 `~/.cobrowse/settings.json`。
 *
 * 语义刻意做成"**第一次 AI 改动之前**的那一份"（而不是每次覆盖）：
 * 那个状态是用户自己配好的已知良好状态。多次 AI 改动后仍然回得到原点。
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../shared/atomic'

export function restorePointPath(directory: string): string {
  return path.join(directory, 'settings.pre-ai.json')
}

/**
 * 在 AI 做第一次设置改动之前调用。已有快照时不覆盖——那才是"原点"。
 * 返回是否新建了快照。
 */
export function ensureRestorePoint(directory: string): boolean {
  const target = restorePointPath(directory)
  try {
    if (fs.existsSync(target)) return false
    const current = path.join(directory, 'settings.json')
    if (!fs.existsSync(current)) return false
    const raw = fs.readFileSync(current, 'utf8')
    JSON.parse(raw) // 只快照可解析的文件，避免把坏文件备份成"原点"
    writeFileAtomic(target, raw)
    return true
  } catch (error) {
    console.error('[settings] 建立 AI 改动的还原点失败：', (error as Error)?.message ?? error)
    return false
  }
}

/**
 * 把设置恢复到 AI 改动之前的快照。
 * 先把当前状态另存一份，避免"恢复"本身不可逆。
 */
export function restoreFromPoint(directory: string): { ok: boolean; error?: string } {
  const point = restorePointPath(directory)
  const current = path.join(directory, 'settings.json')
  try {
    const raw = fs.readFileSync(point, 'utf8')
    JSON.parse(raw)
    if (fs.existsSync(current)) {
      writeFileAtomic(path.join(directory, 'settings.before-restore.json'), fs.readFileSync(current, 'utf8'))
    }
    writeFileAtomic(current, raw)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error)?.message ?? 'restore failed' }
  }
}
