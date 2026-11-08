import { describe, expect, it } from 'vitest'
import { groupHistoryByDay, listHistoryMonths } from '../src/shared/omnibox'
import type { HistoryRecord } from '../src/shared/protocol'

function record(visitedAt: number, url = 'https://example.com/'): HistoryRecord {
  return { url, title: 'Example', visitedAt } as HistoryRecord
}

/**
 * 回归：中文模板用 `{m}月`，英文模板用 `{monthName} {y}`。
 * 调用方原来只传 `{ m }`，于是英文界面把 `{monthName}` 原样显示出来。
 */
describe('历史月份标签（中英占位符不同）', () => {
  const now = new Date(2026, 9, 20) // 2026-10-20
  // 差 17 天：落在"本月"分组（不是今天/昨天/近七天），才会走 monthLabel 分支
  const thisMonth = new Date(2026, 9, 3).getTime()
  const old = new Date(2025, 2, 5).getTime() // 2025-03

  it('英文：本月分组显示月份名，不出现占位符', () => {
    const groups = groupHistoryByDay([record(thisMonth)], now, 'en')
    const label = groups[0]?.label ?? ''
    expect(label).not.toContain('{')
    expect(label.toLowerCase()).toContain('oct')
  })

  it('中文：本月分组显示数字月', () => {
    const groups = groupHistoryByDay([record(thisMonth)], now, 'zh')
    const label = groups[0]?.label ?? ''
    expect(label).not.toContain('{')
    expect(label).toContain('10')
  })

  it('英文：跨年分组的年份标签也完整', () => {
    const groups = groupHistoryByDay([record(old)], now, 'en')
    const label = groups[0]?.label ?? ''
    expect(label).not.toContain('{')
    expect(label).toContain('2025')
    expect(label.toLowerCase()).toContain('mar')
  })

  it('英文：年份筛选 chip 同样不出现占位符', () => {
    const months = listHistoryMonths([record(old)], 'en')
    const label = months[0]?.label ?? ''
    expect(label).not.toContain('{')
    expect(label.toLowerCase()).toContain('mar')
  })

  it('中文：年份筛选 chip 是「2025年3月」', () => {
    const months = listHistoryMonths([record(old)], 'zh')
    expect(months[0]?.label).toContain('2025')
    expect(months[0]?.label).toContain('3')
  })
})
