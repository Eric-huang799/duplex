import { describe, expect, it } from 'vitest'
import { buildOmniboxSuggestions, groupHistoryByDay } from '../src/shared/omnibox'
import type { BookmarkRecord, HistoryRecord } from '../src/shared/protocol'

const h = (url: string, title: string, visitedAt: number): HistoryRecord => ({ url, title, visitedAt })
const b = (url: string, title: string, addedAt = 1): BookmarkRecord => ({ url, title, addedAt })

describe('buildOmniboxSuggestions', () => {
  it('empty input shows the most recent unique history entries', () => {
    const s = buildOmniboxSuggestions(
      '',
      [
        h('https://a.example/', 'A', 100),
        h('https://a.example/', 'A again', 200), // duplicate url keeps the newer visit
        h('https://b.example/', 'B', 300),
        h('https://c.example/', 'C', 50)
      ],
      []
    )
    expect(s.map((x) => x.url)).toEqual(['https://b.example/', 'https://a.example/', 'https://c.example/'])
    expect(s[0].kind).toBe('history')
    expect(s[0].label).toBe('B')
    expect(s[0].sub).toBe('https://b.example/')
  })

  it('puts the search row first for non-empty input', () => {
    const s = buildOmniboxSuggestions('py 教程', [], [], { engineName: '必应' })
    expect(s[0]).toMatchObject({ kind: 'search', label: 'py 教程', url: 'py 教程' })
    expect(s[0].sub).toContain('必应')
  })

  it('matches bookmarks and history without duplicates, bookmarks first', () => {
    const s = buildOmniboxSuggestions(
      'git',
      [h('https://git.example/', 'git 手册', 500), h('https://gitlab.example/', '仓库', 400)],
      [b('https://git.example/', 'Git 官网')]
    )
    expect(s[0].kind).toBe('search')
    expect(s[1]).toMatchObject({ kind: 'bookmark', url: 'https://git.example/' })
    expect(s[2]).toMatchObject({ kind: 'history', url: 'https://gitlab.example/' })
    expect(s.filter((x) => x.url === 'https://git.example/')).toHaveLength(1)
  })

  it('ranks title matches above url-only matches and respects the history limit', () => {
    const history = [
      h('https://aaa.example/xxx', '无关标题', 900), // url-only match, newest
      h('https://bbb.example/', 'aaa 指南', 100) // title match, older
    ]
    const s = buildOmniboxSuggestions('aaa', history, [], { historyLimit: 5 })
    expect(s).toHaveLength(3) // search + 2 matches
    expect(s[1].url).toBe('https://bbb.example/')
    expect(s[2].url).toBe('https://aaa.example/xxx')
  })

  it('caps history matches at historyLimit', () => {
    const history = [1, 2, 3, 4, 5, 6, 7].map((n) => h(`https://x${n}.example/`, `page aaa ${n}`, n))
    const s = buildOmniboxSuggestions('aaa', history, [], { historyLimit: 5 })
    expect(s).toHaveLength(6) // search + 5
    expect(s[1].url).toBe('https://x7.example/') // newest first among equal scores
  })

  it('keeps non-matching input to just the search row', () => {
    const s = buildOmniboxSuggestions('zzzznothing', [h('https://a.example/', 'A', 1)], [])
    expect(s).toHaveLength(1)
    expect(s[0].kind).toBe('search')
  })
})

describe('groupHistoryByDay', () => {
  // 2026-10-10 is a Saturday.
  const now = new Date(2026, 9, 10, 15, 0, 0)
  const t = (day: number, hour: number, month = 9): number => new Date(2026, month, day, hour).getTime()

  it('groups into 今天/昨天/星期X/月份/年份, newest first, records sorted within group', () => {
    const groups = groupHistoryByDay(
      [
        h('https://old.example/', 'old', t(20, 9, 8)), // 9月20日，今年更早
        h('https://today1.example/', 't1', t(10, 8)),
        h('https://yest.example/', 'y', t(9, 22)),
        h('https://wed.example/', 'w', t(7, 12)),
        h('https://today2.example/', 't2', t(10, 10)),
        h('https://ly.example/', 'ly', new Date(2025, 11, 5, 9).getTime())
      ],
      now
    )
    expect(groups.map((g) => g.label)).toEqual(['今天', '昨天', '星期三', '9月', '2025年12月'])
    expect(groups[0].records.map((r) => r.title)).toEqual(['t2', 't1'])
    expect(groups[0].records[0].url).toBe('https://today2.example/')
  })

  it('treats future timestamps (clock skew) as today', () => {
    const groups = groupHistoryByDay([h('https://f.example/', 'f', t(12, 23))], now)
    expect(groups.map((g) => g.label)).toEqual(['今天'])
  })

  it('keeps the search box filtering orthogonal: returns every record', () => {
    const all = [h('https://a.example/', 'a', t(10, 9)), h('https://b.example/', 'b', t(9, 9))]
    const groups = groupHistoryByDay(all, now)
    const total = groups.reduce((n, g) => n + g.records.length, 0)
    expect(total).toBe(2)
  })
})
