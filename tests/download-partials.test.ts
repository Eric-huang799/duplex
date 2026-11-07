import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PartialDownloadStore, type PartialMeta } from '../src/main/download-partials'

function meta(dir: string, id: string, bytes = 4): PartialMeta {
  const temp = path.join(dir, `${id}.duplexpart`)
  fs.writeFileSync(temp, 'x'.repeat(bytes), 'utf8')
  return {
    id,
    url: 'https://example.com/file.bin',
    target: path.join(dir, `${id}.bin`),
    temp,
    receivedBytes: bytes,
    totalBytes: 100,
    updatedAt: Date.now()
  }
}

describe('PartialDownloadStore', () => {
  let dir = ''
  let store: PartialDownloadStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-partials-'))
    store = new PartialDownloadStore(dir)
  })

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('登记后可读回，并以临时文件实际大小为准', () => {
    const m = meta(dir, 'a', 7)
    store.put({ ...m, receivedBytes: 3 }) // 登记值故意写错
    expect(store.get('a')?.receivedBytes).toBe(7)
    expect(new PartialDownloadStore(dir).get('a')?.receivedBytes).toBe(7)
  })

  it('临时文件消失的登记项在重载时被丢弃（避免永远失败的"继续"）', () => {
    store.put(meta(dir, 'gone'))
    fs.rmSync(path.join(dir, 'gone.duplexpart'))
    expect(new PartialDownloadStore(dir).get('gone')).toBeNull()
  })

  it('discard 同时删除登记项与临时文件', () => {
    const m = meta(dir, 'b')
    store.put(m)
    store.discard('b')
    expect(store.get('b')).toBeNull()
    expect(fs.existsSync(m.temp)).toBe(false)
  })

  it('损坏的登记表被忽略而不抛错', () => {
    fs.writeFileSync(path.join(dir, 'download-partials.json'), '{not json', 'utf8')
    expect(new PartialDownloadStore(dir).list()).toEqual([])
  })

  it('list 返回副本，不泄漏内部状态', () => {
    store.put(meta(dir, 'c'))
    const list = store.list()
    list[0]!.receivedBytes = 999
    expect(store.get('c')?.receivedBytes).toBe(4)
  })
})
