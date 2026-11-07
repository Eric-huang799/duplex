import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TimelineStore } from '../src/main/timeline'

describe('TimelineStore', () => {
  let dir = ''
  let store: TimelineStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-timeline-'))
    store = new TimelineStore(dir)
  })

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('没有文件时返回空，不抛错', () => {
    expect(store.recent()).toEqual([])
    expect(store.toMarkdown()).toContain('还没有记录')
  })

  it('追加写并按最新在前返回', () => {
    store.record({ kind: 'tool', name: 'click', tabId: 1, ok: true })
    store.record({ kind: 'tool', name: 'snapshot', tabId: 1, ok: false, detail: '超时' })
    const recent = store.recent()
    expect(recent).toHaveLength(2)
    expect(recent[0]?.name).toBe('snapshot')
    expect(recent[0]?.ok).toBe(false)
    expect(recent[1]?.name).toBe('click')
  })

  it('limit 只取最近 N 条', () => {
    for (let i = 0; i < 5; i++) store.record({ kind: 'tool', name: `t${i}`, ok: true })
    expect(store.recent(2).map((e) => e.name)).toEqual(['t4', 't3'])
  })

  it('坏行被跳过，好行仍然可读', () => {
    store.record({ kind: 'tool', name: 'click', ok: true })
    fs.appendFileSync(store.filePath, '{not json\n', 'utf8')
    store.record({ kind: 'resume', tabId: 1 })
    const recent = store.recent()
    expect(recent.map((e) => e.kind)).toEqual(['resume', 'tool'])
  })

  it('detail 会被裁剪并压掉换行', () => {
    store.record({ kind: 'tool', name: 'x', ok: false, detail: `第一行\n第二行 ${'z'.repeat(400)}` })
    const entry = store.recent()[0]
    expect(entry?.detail?.includes('\n')).toBe(false)
    expect((entry?.detail ?? '').length).toBeLessThanOrEqual(240)
  })

  it('导出 Markdown 含表头与记录', () => {
    store.record({ kind: 'takeover', tabId: 3, detail: '人工正在操作页面' })
    store.record({ kind: 'tool', name: 'click', tabId: 3, ok: true })
    const md = store.toMarkdown()
    expect(md).toContain('# Duplex AI 操作时间线')
    expect(md).toContain('| 时间 | 类型 | 目标 | 结果 |')
    expect(md).toContain('人工接管')
    expect(md).toContain('工具')
    // 正序：接管在前，工具在后
    expect(md.indexOf('人工接管')).toBeLessThan(md.indexOf('| 工具 |'))
  })

  it('超过体积上限时轮转，保留一代', () => {
    // 直接塞一个超过上限的旧文件
    const big = 'x'.repeat(2 * 1024 * 1024 + 10)
    fs.writeFileSync(store.filePath, `${JSON.stringify({ ts: Date.now(), kind: 'tool', name: big })}\n`, 'utf8')
    store.record({ kind: 'tool', name: 'after-rotate', ok: true })
    expect(fs.existsSync(`${store.filePath}.1`)).toBe(true)
    const recent = store.recent()
    expect(recent[0]?.name).toBe('after-rotate')
  })
})
