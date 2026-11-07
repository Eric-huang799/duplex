import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PermissionStore } from '../src/main/permission-store'
import { createSitePermissionHandlers } from '../src/main/agent/permission-tools'

type Handlers = ReturnType<typeof createSitePermissionHandlers>

function body(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n')
}

/** 所有 handler 都返回 ToolResult；测试里用不到 isError 之外的结构。 */
function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

describe('站点权限工具', () => {
  let dir = ''
  let store: PermissionStore
  let handlers: Handlers
  let confirm: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-perm-tools-'))
    store = new PermissionStore(dir)
    confirm = vi.fn(async () => true)
    handlers = createSitePermissionHandlers(confirm as never, () => store)
  })

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('拒绝带路径的 origin（不允许把 URL 变成规则键）', async () => {
    const r = await handlers.set_site_permission({
      origin: 'https://a.example.com/some/path',
      category: 'media',
      decision: 'allow'
    })
    expect(isError(r)).toBe(true)
    expect(store.list()).toEqual([])
  })

  it('拒绝明文 http 的公网地址，但接受 localhost', async () => {
    const bad = await handlers.set_site_permission({
      origin: 'http://intranet.corp',
      category: 'notifications',
      decision: 'allow'
    })
    expect(isError(bad)).toBe(true)

    const ok = await handlers.set_site_permission({
      origin: 'http://localhost:3000',
      category: 'notifications',
      decision: 'allow'
    })
    expect(isError(ok)).toBe(false)
  })

  it('放宽高危类别（media）必须先经过人工确认', async () => {
    const r = await handlers.set_site_permission({
      origin: 'https://meeting.tencent.com',
      category: 'media',
      decision: 'allow'
    })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(isError(r)).toBe(false)
    expect(store.ruleFor('https://meeting.tencent.com')?.decisions.media).toBe('allow')
  })

  it('用户拒绝确认时不写入任何规则', async () => {
    confirm.mockResolvedValueOnce(false)
    const r = await handlers.set_site_permission({
      origin: 'https://evil.example',
      category: 'media',
      decision: 'allow'
    })
    expect(isError(r)).toBe(true)
    expect(store.ruleFor('https://evil.example')).toBeNull()
  })

  it('放宽无风险类别不需要确认，并记为 agent 改动', async () => {
    const r = await handlers.set_site_permission({
      origin: 'https://bilibili.com',
      category: 'fullscreen',
      decision: 'deny'
    })
    expect(isError(r)).toBe(false)
    // fullscreen 的内置默认就是 allow，写 deny 才是一条真实规则
    expect(confirm).not.toHaveBeenCalled()
    expect(store.ruleFor('https://bilibili.com')?.decisions.fullscreen).toBe('deny')
    expect(store.ruleFor('https://bilibili.com')?.source).toBe('agent')
  })

  it('收紧（deny / ask）永远不需要确认', async () => {
    await handlers.set_site_permission({
      origin: 'https://a.example.com',
      category: 'geolocation',
      decision: 'deny'
    })
    await handlers.set_site_permission({
      origin: 'https://a.example.com',
      category: 'notifications',
      decision: 'ask'
    })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('重复设置同一个值报告未变化', async () => {
    await handlers.set_site_permission({
      origin: 'https://a.example.com',
      category: 'geolocation',
      decision: 'deny'
    })
    const again = await handlers.set_site_permission({
      origin: 'https://a.example.com',
      category: 'geolocation',
      decision: 'deny'
    })
    expect(body(again as never)).toContain('未变化')
  })

  it('未知类别被拒绝并列出可选项', async () => {
    const r = await handlers.set_site_permission({
      origin: 'https://a.example.com',
      category: 'teleport',
      decision: 'allow'
    })
    expect(isError(r)).toBe(true)
    expect(body(r as never)).toContain('media')
  })

  it('list 返回类别表、全局覆盖与 origin 规则', async () => {
    await handlers.set_site_permission({
      origin: 'https://a.example.com',
      category: 'geolocation',
      decision: 'deny'
    })
    const listed = JSON.parse(body((await handlers.list_site_permissions({})) as never)) as {
      categories: string[]
      origins: Array<{ origin: string; source: string }>
    }
    expect(listed.categories).toContain('media')
    expect(listed.origins).toHaveLength(1)
    expect(listed.origins[0]?.origin).toBe('https://a.example.com')
    expect(listed.origins[0]?.source).toBe('agent')
  })

  it('remove 支持单类别与整站清空', async () => {
    await handlers.set_site_permission({
      origin: 'https://a.example.com',
      category: 'geolocation',
      decision: 'deny'
    })
    await handlers.set_site_permission({
      origin: 'https://a.example.com',
      category: 'notifications',
      decision: 'deny'
    })
    const one = await handlers.remove_site_permission({
      origin: 'https://a.example.com',
      category: 'geolocation'
    })
    expect(body(one as never)).toContain('1 条')
    const all = await handlers.remove_site_permission({ origin: 'https://a.example.com' })
    expect(body(all as never)).toContain('1 条')
    expect(store.ruleFor('https://a.example.com')).toBeNull()
  })
})
