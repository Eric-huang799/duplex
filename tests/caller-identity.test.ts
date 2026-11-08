import { describe, expect, it } from 'vitest'
import { bridgeCallerId, CALLER_ID_PATTERN } from '../src/shared/caller-id'

describe('外部 agent 身份', () => {
  it('同一安装 + 同一工作目录 = 同一身份（重启后「始终允许」不会重问）', () => {
    const a = bridgeCallerId({ dataDir: '/data/duplex', cwd: '/work/proj-a', env: {} })
    const b = bridgeCallerId({ dataDir: '/data/duplex', cwd: '/work/proj-a', env: {} })
    expect(a).toBe(b)
  })

  it('不同工作目录 = 不同身份（两个项目里的 agent 不再共用一个授权桶）', () => {
    const a = bridgeCallerId({ dataDir: '/data/duplex', cwd: '/work/proj-a', env: {} })
    const b = bridgeCallerId({ dataDir: '/data/duplex', cwd: '/work/proj-b', env: {} })
    expect(a).not.toBe(b)
  })

  it('DUPLEX_CALLER_ID 优先，且必须符合 HTTP 头规则', () => {
    const custom = bridgeCallerId({ dataDir: '/data/duplex', cwd: '/w', env: { DUPLEX_CALLER_ID: 'agent-1' } })
    expect(custom).toBe('agent-1')
    // 非法值（含空格/中文）回退到派生身份，而不是把脏值送到 HTTP 头
    const fallback = bridgeCallerId({
      dataDir: '/data/duplex',
      cwd: '/w',
      env: { DUPLEX_CALLER_ID: 'bad id 中文' }
    })
    expect(fallback).not.toBe('bad id 中文')
    expect(CALLER_ID_PATTERN.test(fallback)).toBe(true)
  })

  it('派生身份始终是合法标识符', () => {
    for (const cwd of ['/a', 'C:\\work\\项目', '']) {
      expect(CALLER_ID_PATTERN.test(bridgeCallerId({ dataDir: '/d', cwd, env: {} }))).toBe(true)
    }
  })
})
