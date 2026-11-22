import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AssetStore, assetIdFor, imageSize, mimeForName, sanitizeAssetName } from '../src/main/assets'
import { removeTestDir } from './fs-cleanup'

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-assets-'))
}

describe('资产元数据', () => {
  it('mime 按扩展名推断，未知回落 octet-stream', () => {
    expect(mimeForName('a.PNG')).toBe('image/png')
    expect(mimeForName('b.jpeg')).toBe('image/jpeg')
    expect(mimeForName('c.weird')).toBe('application/octet-stream')
  })

  it('文件名清洗掉路径分隔符与控制字符，并保留长度上限', () => {
    expect(sanitizeAssetName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeAssetName('..\\..\\x\u0000y.png')).toBe('x_y.png')
    expect(sanitizeAssetName('   ')).toBe('asset')
    expect(sanitizeAssetName('a'.repeat(300)).length).toBe(120)
  })

  it('PNG 尺寸从 IHDR 读取（1×1）', () => {
    expect(imageSize(PNG_1x1)).toEqual({ width: 1, height: 1 })
    expect(imageSize(Buffer.from('not an image'))).toBeUndefined()
  })
})

describe('AssetStore', () => {
  it('内容寻址：同内容重复导入只保留一份，id 稳定', () => {
    const root = tempRoot()
    try {
      const store = new AssetStore(root)
      const a = store.importBuffer(PNG_1x1, { name: 'dot.png', importedAt: 1 })
      const b = store.importBuffer(PNG_1x1, { name: 'same.png', importedAt: 2 })
      expect(a.id).toBe(b.id)
      expect(store.list()).toHaveLength(1)
      expect(a.width).toBe(1)
      expect(a.height).toBe(1)
      expect(a.id).toBe(assetIdFor(a.sha256))
      expect(store.filePath(a.id)).toBeTruthy()
    } finally {
      removeTestDir(root)
    }
  })

  it('多份资产按导入时间倒序，复制到目标目录返回文件名', () => {
    const root = tempRoot()
    try {
      const store = new AssetStore(root)
      const first = store.importBuffer(PNG_1x1, { name: 'a.png', importedAt: 1 })
      const other = Buffer.from('hello', 'utf8')
      const second = store.importBuffer(other, { name: 'note.txt', importedAt: 2, mime: 'text/plain' })
      expect(store.list().map((entry) => entry.id)).toEqual([second.id, first.id])
      const target = path.join(root, 'export')
      const name = store.copyTo(first.id, target)
      expect(name).toBe(`${first.id}.png`)
      expect(fs.existsSync(path.join(target, name!))).toBe(true)
      expect(store.copyTo('missing', target)).toBeNull()
    } finally {
      removeTestDir(root)
    }
  })

  it('拒绝空资产；重新打开实例能读回索引', () => {
    const root = tempRoot()
    try {
      const store = new AssetStore(root)
      expect(() => store.importBuffer(Buffer.alloc(0), { name: 'x' })).toThrow(/空/)
      store.importBuffer(PNG_1x1, { name: 'dot.png' })
      const reopened = new AssetStore(root)
      expect(reopened.list()).toHaveLength(1)
      expect(reopened.get(reopened.list()[0].id)?.name).toBe('dot.png')
    } finally {
      removeTestDir(root)
    }
  })
})
