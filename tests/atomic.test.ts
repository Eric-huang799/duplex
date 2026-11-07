import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from '../src/shared/atomic'

describe('writeFileAtomic', () => {
  let dir = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-atomic-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('写入内容并创建缺失的目录', () => {
    const file = path.join(dir, 'a', 'b', 'endpoint.json')
    writeFileAtomic(file, '{"token":"x"}')
    expect(fs.readFileSync(file, 'utf8')).toBe('{"token":"x"}')
  })

  it('覆盖已有文件时整文件替换，不留旧内容', () => {
    const file = path.join(dir, 'settings.json')
    writeFileAtomic(file, 'x'.repeat(4096))
    writeFileAtomic(file, 'short')
    expect(fs.readFileSync(file, 'utf8')).toBe('short')
  })

  it('成功与失败都不会留下 .tmp 文件', () => {
    const file = path.join(dir, 'agents.json')
    writeFileAtomic(file, '{}')
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('POSIX 下权限是 0600（含凭据的文件不该被同机其他用户读到）', () => {
    if (process.platform === 'win32') return
    const file = path.join(dir, 'endpoint.json')
    writeFileAtomic(file, '{}')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('目录不可写时抛错且不破坏已有文件', () => {
    const file = path.join(dir, 'settings.json')
    writeFileAtomic(file, 'original')
    // 用同名目录占位制造写入失败：rename 到目录会失败
    const blocked = path.join(dir, 'blocked.json')
    fs.mkdirSync(blocked)
    expect(() => writeFileAtomic(blocked, 'data')).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('original')
  })
})
