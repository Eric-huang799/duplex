import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DesignService } from '../src/main/design/service'
import { renderStaticSite } from '../src/shared/design/export'
import { emptyDocument } from '../src/shared/design/model'

const actor = 'designer'

function seededDoc() {
  const doc = emptyDocument('落地页', 'demo')
  doc.root.children = [
    {
      id: 'hero',
      type: 'stack',
      style: { padding: '48px', background: 'brand.primary', gap: '12px' },
      children: [
        { id: 'title', type: 'heading', text: '和 AI 一起设计' },
        { id: 'cta', type: 'button', text: '开始 <now>' }
      ]
    },
    { id: 'floating', type: 'box', style: { x: '720', y: '360', w: '120' }, children: [] }
  ]
  return doc
}

describe('静态站点导出（可交付）', () => {
  it('生成真实 HTML/CSS：tokens 变 CSS 变量、节点带 data-did、文本转义、绝对定位转百分比', () => {
    const doc = seededDoc()
    const { html, css } = renderStaticSite(doc)

    expect(html).toContain('<!doctype html>')
    expect(html).toContain('data-did="hero"')
    expect(html).toContain('data-did="title"')
    // 文本被转义，不输出裸尖括号
    expect(html).toContain('开始 &lt;now&gt;')
    expect(html).not.toContain('<now>')

    expect(css).toContain('--color-brand-primary')
    expect(css).toContain('var(--color-brand-primary)')
    // 720/1440 = 50%
    expect(css).toContain('left: 50.000%')
    // 360/900 = 40%
    expect(css).toContain('top: 40.000%')
    // 容器结构
    expect(css).toContain('display: flex')
  })

  it('exportZip 会先写 site/ 并提交，再打包（zip 存在且非空）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-design-export-'))
    try {
      const service = new DesignService({ root })
      service.open('demo')
      service.applyOps(actor, [
        { op: 'insert', parentId: 'root', node: { id: 'hero', type: 'stack', children: [] } },
        { op: 'update', targetId: 'hero', patch: { text: 'hi' } }
      ])
      service.commitRound('第一轮')

      const target = path.join(root, 'export.zip')
      const outcome = service.exportZip(target)
      expect(outcome.ok).toBe(true)
      expect(fs.existsSync(target)).toBe(true)
      expect(fs.statSync(target).size).toBeGreaterThan(0)

      const siteDir = path.join(root, 'demo', 'site')
      expect(fs.existsSync(path.join(siteDir, 'index.html'))).toBe(true)
      const css = fs.readFileSync(path.join(siteDir, 'styles.css'), 'utf8')
      expect(css).toContain(':root')
      const html = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8')
      expect(html).toContain('data-did="hero"')

      // 导出本身也进 git 历史（用户能在历史里找到"构建静态站点"这一轮）
      const history = service.history(5)
      expect(history.some((entry) => entry.subject.includes('构建静态站点'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
