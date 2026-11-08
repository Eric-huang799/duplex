import { describe, expect, it } from 'vitest'
import { mergeSession, sessionCallerId } from '../src/main/agent/session-runner'
import type { AgentSession } from '../src/main/agent/store'

const make = (id: string, title = id): AgentSession => ({
  id,
  title,
  createdAt: 0,
  updatedAt: 1,
  messages: [],
  uiEvents: []
})

describe('并行会话的身份', () => {
  it('每个会话得到不同的 caller，且只含 ASCII', () => {
    const a = sessionCallerId('demo-a')
    const b = sessionCallerId('demo-b')
    expect(a).toBe('builtin:demo-a')
    expect(b).toBe('builtin:demo-b')
    expect(a).not.toBe(b)
  })

  it('中文/空格/特殊字符被清掉，不回退成同一个身份', () => {
    const a = sessionCallerId('会话 一号')
    const b = sessionCallerId('会话 二号')
    expect(a).toMatch(/^builtin:[A-Za-z0-9._-]+$/)
    expect(b).toMatch(/^builtin:[A-Za-z0-9._-]+$/)
    expect(a).not.toBe(b)
  })

  it('空 id 也有可用的身份：带哈希后缀，稳定且不会与别的会话撞车', () => {
    const empty = sessionCallerId('')
    expect(empty).toMatch(/^builtin:session-[0-9a-f]{6}$/)
    expect(sessionCallerId('')).toBe(empty)
  })
})

describe('后台会话的保存合并', () => {
  it('只替换自己的那条，其它会话（包括主实例正在写的）原样保留', () => {
    const disk = [make('a', '旧 A'), make('b', 'B')]
    const updated = { ...make('a', '新 A'), updatedAt: 2 }
    const merged = mergeSession(disk, updated)
    expect(merged.find((s) => s.id === 'a')?.title).toBe('新 A')
    expect(merged.find((s) => s.id === 'b')?.title).toBe('B')
    expect(merged).toHaveLength(2)
  })

  it('新会话被插入而不是覆盖别人', () => {
    const merged = mergeSession([make('b')], make('c'))
    expect(merged.map((s) => s.id)).toEqual(['c', 'b'])
  })
})
