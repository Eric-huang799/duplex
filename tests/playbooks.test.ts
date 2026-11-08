import { describe, expect, it } from 'vitest'
import { PLAYBOOKS, findPlaybook, playbooksByCategory } from '../src/shared/playbooks'

const REQUIRED_IDS = [
  'compare-products',
  'page-to-table',
  'fill-form-demo',
  'compare-meeting-times',
  'summarize-article',
  'compare-flights-hotels',
  'recipe-shopping-list',
  'paper-brief',
  'draft-email',
  'filter-jobs'
]

describe('预置任务数据', () => {
  it('恰好 10 条，id 唯一且格式稳定', () => {
    expect(PLAYBOOKS).toHaveLength(10)
    const ids = PLAYBOOKS.map((playbook) => playbook.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('每条都有中英文标题、指令和正整数预计时长', () => {
    for (const playbook of PLAYBOOKS) {
      expect(playbook.title.zh.trim().length).toBeGreaterThan(0)
      expect(playbook.title.en.trim().length).toBeGreaterThan(0)
      expect(playbook.prompt.zh.trim().length).toBeGreaterThan(0)
      expect(playbook.prompt.en.trim().length).toBeGreaterThan(0)
      expect(Number.isInteger(playbook.etaMinutes)).toBe(true)
      expect(playbook.etaMinutes).toBeGreaterThan(0)
    }
  })

  it('覆盖需求里的 10 个真实任务', () => {
    expect(PLAYBOOKS.map((playbook) => playbook.id).sort()).toEqual([...REQUIRED_IDS].sort())
    for (const id of REQUIRED_IDS) expect(findPlaybook(id)).not.toBeNull()
  })

  it('每条指令都要求先 snapshot 观察、提交类动作前停下等确认', () => {
    for (const playbook of PLAYBOOKS) {
      expect(playbook.prompt.zh).toContain('browser_snapshot')
      expect(playbook.prompt.zh).toMatch(/确认/)
      expect(playbook.prompt.zh).toMatch(/提交|发送|下单|付款/)

      expect(playbook.prompt.en).toContain('browser_snapshot')
      expect(playbook.prompt.en).toMatch(/confirm/i)
      expect(playbook.prompt.en).toMatch(/submit|send|order|payment/i)
    }
  })

  it('每类任务带上自己的关键约束（假数据 / 付费墙 / 登录墙 / 不投递）', () => {
    const form = findPlaybook('fill-form-demo')
    expect(form?.prompt.zh).toContain('假数据')
    expect(form?.prompt.zh).toContain('13800000000')
    expect(form?.prompt.zh).toContain('不要套用我的真实信息')

    const article = findPlaybook('summarize-article')
    expect(article?.prompt.zh).toMatch(/付费墙/)
    expect(article?.prompt.zh).toContain('不要绕过')

    const paper = findPlaybook('paper-brief')
    expect(paper?.prompt.zh).toContain('付费墙')

    const jobs = findPlaybook('filter-jobs')
    expect(jobs?.prompt.zh).toContain('不要投递')
    expect(jobs?.prompt.zh).toContain('登录')
  })

  it('邮件草稿必须明确要求用户确认后才能发送', () => {
    const email = findPlaybook('draft-email')
    expect(email?.prompt.zh).toContain('不要点击发送')
    expect(email?.prompt.zh).toContain('确认发送')
    expect(email?.prompt.en.toLowerCase()).toContain('do not click send')
    expect(email?.prompt.en.toLowerCase()).toContain('confirm send')
  })
})

describe('playbooksByCategory', () => {
  it('按语言返回中文 / 英文类别名，且不重复', () => {
    const zhGroups = playbooksByCategory('zh')
    const enGroups = playbooksByCategory('en')

    expect(zhGroups.map((group) => group.category)).toEqual([
      '购物与比价',
      '信息整理与研究',
      '表单与填写',
      '行程与会议',
      '写作与沟通',
      '求职'
    ])
    expect(enGroups.map((group) => group.category)).toEqual([
      'Shopping & price checks',
      'Research & synthesis',
      'Forms & filling',
      'Travel & scheduling',
      'Writing & communication',
      'Job search'
    ])
    for (const group of enGroups) expect(group.category).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('分组后仍是全部 10 条，每条都留在自己的类别里', () => {
    for (const lang of ['zh', 'en'] as const) {
      const groups = playbooksByCategory(lang)
      const flat = groups.flatMap((group) => group.items)
      expect(flat).toHaveLength(PLAYBOOKS.length)
      expect(flat.map((playbook) => playbook.id).sort()).toEqual(
        PLAYBOOKS.map((playbook) => playbook.id).sort()
      )
      expect(new Set(groups.map((group) => group.category)).size).toBe(groups.length)
      for (const group of groups) {
        expect(new Set(group.items.map((playbook) => playbook.category)).size).toBe(1)
        const ids = new Set(group.items.map((playbook) => playbook.id))
        const expected = PLAYBOOKS.filter((playbook) => ids.has(playbook.id))
        expect(group.items).toEqual(expected)
      }
    }
  })

  it('同类任务聚在一起，组内保持原始顺序', () => {
    const research = playbooksByCategory('zh').find(
      (group) => group.category === '信息整理与研究'
    )
    expect(research?.items.map((playbook) => playbook.id)).toEqual([
      'page-to-table',
      'summarize-article',
      'paper-brief'
    ])
  })

  it('每次返回全新数组，面板改分组不会污染 PLAYBOOKS', () => {
    const first = playbooksByCategory('zh')
    const second = playbooksByCategory('zh')
    expect(first).not.toBe(second)
    expect(first[0].items).not.toBe(second[0].items)

    first[0].items.pop()
    expect(second[0].items).toHaveLength(2)
    expect(PLAYBOOKS).toHaveLength(10)
  })
})

describe('findPlaybook', () => {
  it('命中时返回同一条数据', () => {
    expect(findPlaybook('compare-products')).toBe(PLAYBOOKS[0])
    expect(findPlaybook('draft-email')?.category).toBe('writing')
  })

  it('未知 id 或空字符串返回 null', () => {
    expect(findPlaybook('not-a-playbook')).toBeNull()
    expect(findPlaybook('')).toBeNull()
    expect(findPlaybook('COMPARE-PRODUCTS')).toBeNull()
  })
})
