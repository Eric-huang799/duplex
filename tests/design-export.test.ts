import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DesignService } from '../src/main/design/service'
import { renderStaticSite } from '../src/shared/design/export'
import { emptyDocument } from '../src/shared/design/model'
import { removeTestDir } from './fs-cleanup'

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

  it('自定义语义标签与画布一致，危险标签回退到安全默认值', () => {
    const doc = seededDoc()
    doc.root.children!.push(
      { id: 'semantic', type: 'box', tag: 'section', text: '语义区块' },
      { id: 'unsafe-tag', type: 'box', tag: 'script', text: '不能变成脚本' }
    )

    const { html } = renderStaticSite(doc)
    expect(html).toMatch(/<section class="d-node [^"]+" data-did="semantic">/)
    expect(html).toMatch(/<div class="d-node [^"]+" data-did="unsafe-tag">/)
    expect(html).not.toContain('<script')
  })

  it('button/input 的导出行为由最终标签决定，而不是原始节点类型', () => {
    const doc = seededDoc()
    doc.root.children!.push(
      { id: 'button-as-div', type: 'button', tag: 'div', text: '普通区块' },
      { id: 'box-as-button', type: 'box', tag: 'button', text: '语义按钮' },
      { id: 'input-as-div', type: 'input', tag: 'div', text: '普通文本' },
      { id: 'box-as-input', type: 'box', tag: 'input', text: '只读值' }
    )

    const { html } = renderStaticSite(doc)
    expect(html).toMatch(/<div [^>]*data-did="button-as-div">普通区块<\/div>/)
    expect(html).not.toMatch(/<div [^>]*data-did="button-as-div"[^>]*type="button"/)
    expect(html).toMatch(/<button [^>]*data-did="box-as-button"[^>]*type="button"/)
    expect(html).toMatch(/<div [^>]*data-did="input-as-div">普通文本<\/div>/)
    expect(html).toMatch(/<input [^>]*data-did="box-as-input"[^>]*value="只读值"[^>]*readonly \/>/)
  })

  it('导出过滤可截断声明的属性、值和 token，不生成额外 CSS 规则', () => {
    const doc = seededDoc()
    doc.root.children!.push({
      id: 'unsafe-css',
      type: 'box',
      style: {
        color: 'red; }\nbody { display: none; } /*',
        'font-size; }': '12px',
        background: 'url(https://evil.example/tracker)',
        borderImage: 'image-set("https://evil.example/image-set" 1x)',
        listStyle: '-webkit-image-set("https://evil.example/webkit-image-set" 1x)'
      }
    })
    doc.tokens.color['bad'] = 'red; }\n@import url(https://evil.example/import); /*'

    const { css } = renderStaticSite(doc)
    expect(css).not.toContain('display: none')
    expect(css).not.toContain('font-size;')
    expect(css).not.toContain('@import')
    expect(css).not.toContain('evil.example')
  })

  it('不同节点 id 即使包含不同标点，也不会导出成同一个 CSS 类名', () => {
    const doc = seededDoc()
    doc.root.children!.push(
      { id: 'a.b', type: 'box', style: { color: '#111111' } },
      { id: 'a:b', type: 'box', style: { color: '#222222' } }
    )

    const { html, css } = renderStaticSite(doc)
    const first = /class="d-node ([^"]+)" data-did="a\.b"/.exec(html)?.[1]
    const second = /class="d-node ([^"]+)" data-did="a:b"/.exec(html)?.[1]
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    expect(first).not.toBe(second)
    expect(css).toContain(`.${first} {`)
    expect(css).toContain(`.${second} {`)
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
      removeTestDir(root)
    }
  })

  it('已有历史时，导出前提交失败必须报错且不能打包旧 HEAD', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-design-export-'))
    try {
      const service = new DesignService({ root })
      service.open('demo')
      expect(service.commitRound('初始版本').ok).toBe(true)
      const commit = vi.spyOn(service, 'commitRound').mockReturnValue({ ok: false, error: 'commit failed' })
      const target = path.join(root, 'must-not-exist.zip')

      const outcome = service.exportZip(target)
      expect(outcome).toEqual({ ok: false, error: 'commit failed' })
      expect(commit).toHaveBeenCalledOnce()
      expect(fs.existsSync(target)).toBe(false)
    } finally {
      vi.restoreAllMocks()
      removeTestDir(root)
    }
  })
})

describe('静态导出：图片资产', () => {
  it('图片节点按 assetHref 输出本地相对路径', () => {
    const doc = emptyDocument('t', 'img')
    doc.root.children = [
      { id: 'hero-img', type: 'image', text: '封面', style: { assetId: 'a-1234567890abcdef' } }
    ]
    const site = renderStaticSite(doc, {
      assetHref: (id) => (id === 'a-1234567890abcdef' ? 'assets/a-1234567890abcdef.png' : null)
    })
    expect(site.html).toContain('<img')
    expect(site.html).toContain('src="assets/a-1234567890abcdef.png"')
    expect(site.html).toContain('alt="封面"')
    expect(site.css).toContain('object-fit: cover')
    expect(site.css).not.toContain('assetId')
  })
})
