import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyDocument, type DesignDocument } from '../src/shared/design/model'
import {
  appendRoundLog,
  designsRoot,
  documentPath,
  listProjects,
  loadDocument,
  projectDir,
  roundsLogPath,
  saveDocument
} from '../src/main/design/store'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-store-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function seededDoc(name: string, id: string): DesignDocument {
  const doc = emptyDocument(name, id)
  doc.root.children = [
    {
      id: 'hero',
      type: 'box',
      children: [{ id: 'title', type: 'heading', text: '你好' }]
    }
  ]
  doc.version = 3
  doc.updatedAt = 1_700_000_000_000
  return doc
}

describe('store：文档持久化（注入 root，不写真实目录）', () => {
  it('roundtrip：保存后读回完全一致，且不残留 .tmp', () => {
    const doc = seededDoc('首页', 'p1')
    saveDocument('p1', doc, root)

    const file = documentPath(root, 'p1')
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toContain('"id": "p1"')

    expect(loadDocument('p1', root)).toEqual(doc)

    const leftovers = fs
      .readdirSync(projectDir(root, 'p1'))
      .filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('不存在时返回空文档（项目 id 同时作为文档 id 与初始名称）', () => {
    const doc = loadDocument('brand-new', root)
    expect(doc.id).toBe('brand-new')
    expect(doc.name).toBe('brand-new')
    expect(doc.version).toBe(0)
    expect(doc.root).toEqual({ id: 'root', type: 'page', children: [] })
    expect(doc.constraints).toEqual([])
    expect(doc.variants).toEqual([])
  })

  it('损坏的 JSON：备份成 design.json.corrupt-<ts>，返回空文档，不静默丢数据', () => {
    const dir = projectDir(root, 'broken')
    fs.mkdirSync(dir, { recursive: true })
    const file = documentPath(root, 'broken')
    fs.writeFileSync(file, '{ not valid json', 'utf8')

    const doc = loadDocument('broken', root)
    expect(doc.version).toBe(0)
    expect(doc.id).toBe('broken')

    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('design.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, backups[0]), 'utf8')).toBe('{ not valid json')
    // 原名文件被移走：再次 load 不会重复备份
    expect(fs.existsSync(file)).toBe(false)
    loadDocument('broken', root)
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('design.json.corrupt-'))).toHaveLength(1)
  })

  it('结构不对的 JSON（不是设计文档）同样进备份而不是当成文档', () => {
    const dir = projectDir(root, 'wrong-shape')
    fs.mkdirSync(dir, { recursive: true })
    const file = documentPath(root, 'wrong-shape')
    fs.writeFileSync(file, JSON.stringify({ hello: 'world' }), 'utf8')

    expect(loadDocument('wrong-shape', root).version).toBe(0)
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('design.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(path.join(dir, backups[0]), 'utf8'))).toEqual({ hello: 'world' })
  })

  it('拒绝路径穿越 / Windows 保留名', () => {
    expect(() => loadDocument('../escape', root)).toThrow(/项目 id 不合法/)
    expect(() => saveDocument('CON', seededDoc('x', 'CON'), root)).toThrow(/项目 id 不合法/)
    expect(path.basename(designsRoot())).toBe('designs')
  })

  it('listProjects：按 updatedAt 倒序、同时间按 id 升序；忽略非法目录与非目录', () => {
    const rows: Array<[string, string, number]> = [
      ['alpha', 'Alpha', 100],
      ['beta', 'Beta', 300],
      ['gamma', 'Gamma', 200],
      ['delta', 'Delta', 300]
    ]
    for (const [id, name, updatedAt] of rows) {
      const doc = emptyDocument(name, id)
      doc.updatedAt = updatedAt
      saveDocument(id, doc, root)
    }
    fs.writeFileSync(path.join(root, 'notes.txt'), 'not a project', 'utf8')
    fs.mkdirSync(path.join(root, 'bad id'))

    expect(listProjects(root).map((project) => project.id)).toEqual(['beta', 'delta', 'gamma', 'alpha'])
    expect(listProjects(root)[0]).toEqual({
      id: 'beta',
      name: 'Beta',
      version: 0,
      updatedAt: 300
    })
    expect(listProjects(path.join(root, 'missing-dir'))).toEqual([])
  })

  it('rounds.log 追加一行一条（服务写入的格式由 service 负责）', () => {
    appendRoundLog('p1', '2026-01-01T00:00:00.000Z | 第一轮 | abc123 | deadbeef', root)
    appendRoundLog('p1', '2026-01-02T00:00:00.000Z | 第二轮 | def456 | cafebabe', root)
    const lines = fs.readFileSync(roundsLogPath(root, 'p1'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('第一轮')
    expect(lines[1]).toContain('cafebabe')
  })
})
