import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  commitRound,
  ensureRepo,
  exportZip,
  headSha,
  history,
  isGitAvailable,
  revertTo
} from '../src/main/design/git'

// 环境里没有 git 时整组跳过（与任务要求一致）。
const hasGit = spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0
const describeGit = hasGit ? describe : describe.skip

const dirs: string[] = []

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-git-'))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

describeGit('git：设计工作区版本', () => {
  it('ensureRepo：init + .gitignore；空目录不造空提交；幂等', () => {
    const dir = makeDir()
    const first = ensureRepo(dir)
    expect(first.ok).toBe(true)
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true)

    const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')
    expect(ignore).toContain('node_modules/')
    expect(ignore).toContain('dist/')
    expect(ignore).toContain('*.tmp')

    // 只有 .gitignore 时不提交：第一轮提交留给 design.json。
    expect(headSha(dir)).toBeNull()
    expect(history(dir)).toEqual([])

    const second = ensureRepo(dir)
    expect(second.ok).toBe(true)
    expect(headSha(dir)).toBeNull()
    const lines = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').trim().split('\n')
    expect(lines.filter((line) => line === 'node_modules/')).toHaveLength(1)
  })

  it('已有内容的目录：ensureRepo 会做初始提交', () => {
    const dir = makeDir()
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed', 'utf8')
    expect(ensureRepo(dir).ok).toBe(true)
    const rounds = history(dir)
    expect(rounds).toHaveLength(1)
    expect(rounds[0].subject).toBe('初始化设计工作区')
    expect(rounds[0].sha).toBe(headSha(dir))
  })

  it('commit → history 1 条 → 无改动 skipped → revertTo 生效', () => {
    const dir = makeDir()
    expect(ensureRepo(dir).ok).toBe(true)
    fs.writeFileSync(path.join(dir, 'design.json'), '{"version":1}\n', 'utf8')

    const first = commitRound(dir, '第一轮：搭首页')
    expect(first.ok).toBe(true)
    expect(first.sha).toMatch(/^[0-9a-f]{40,64}$/i)

    const rounds = history(dir)
    expect(rounds).toHaveLength(1)
    expect(rounds[0].sha).toBe(first.sha)
    expect(rounds[0].subject).toBe('第一轮：搭首页')
    expect(rounds[0].short.length).toBeGreaterThan(0)
    expect(rounds[0].date).toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(history(dir, 1)).toHaveLength(1)

    // 无改动：skipped，不造空提交
    const skipped = commitRound(dir, '没有改动')
    expect(skipped.ok).toBe(true)
    expect(skipped.skipped).toBe(true)
    expect(history(dir)).toHaveLength(1)

    // 第二轮
    fs.writeFileSync(path.join(dir, 'design.json'), '{"version":2}\n', 'utf8')
    const second = commitRound(dir, '第二轮：改文案')
    expect(second.ok).toBe(true)
    expect(history(dir)).toHaveLength(2)
    expect(history(dir)[0].sha).toBe(second.sha)

    // revert 第二轮：design.json 回到第一轮内容
    const reverted = revertTo(dir, second.sha!)
    expect(reverted.ok).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'design.json'), 'utf8')).toBe('{"version":1}\n')
    expect(history(dir)).toHaveLength(3)
    expect(history(dir)[0].sha).toBe(reverted.sha)
    expect(history(dir)[0].subject).toContain('Revert')
  }, 60_000)

  it('revertTo：非法 sha / 不存在 sha 都返回错误，并且不破坏工作区', () => {
    const dir = makeDir()
    expect(ensureRepo(dir).ok).toBe(true)
    fs.writeFileSync(path.join(dir, 'design.json'), '{"version":1}\n', 'utf8')
    expect(commitRound(dir, '第一轮').ok).toBe(true)

    expect(revertTo(dir, '--hard').ok).toBe(false)
    const missing = revertTo(dir, 'abcdef1234')
    expect(missing.ok).toBe(false)
    expect(missing.error).toMatch(/提交不存在/)
    expect(fs.readFileSync(path.join(dir, 'design.json'), 'utf8')).toBe('{"version":1}\n')
  }, 30_000)

  it('exportZip：未提交时报错；提交后导出 HEAD 的 zip', () => {
    const dir = makeDir()
    const target = path.join(dir, 'exports', 'site.zip')

    const before = exportZip(dir, target)
    expect(before.ok).toBe(false)
    expect(before.error).toMatch(/尚未提交过任何轮次/)

    expect(ensureRepo(dir).ok).toBe(true)
    fs.writeFileSync(path.join(dir, 'design.json'), '{"version":1}\n', 'utf8')
    // 还没有任何轮次（仓库甚至还没有 HEAD）
    expect(exportZip(dir, target).ok).toBe(false)

    expect(commitRound(dir, '第一轮').ok).toBe(true)
    const zip = exportZip(dir, target)
    expect(zip.ok).toBe(true)
    expect(zip.path).toBe(path.resolve(target))
    const bytes = fs.readFileSync(target)
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK')
  }, 30_000)

  it('isGitAvailable 与当前环境一致', () => {
    expect(isGitAvailable()).toBe(hasGit)
  })
})
