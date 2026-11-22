/**
 * 本地资产库：内容寻址存储 + 元数据索引。
 *
 * 设计意图（与"对话内 artifact"配套）：
 *  - 一份资产可以被设计画布（图片节点）、视觉分析、溯源研究共用；
 *  - 文件按 sha256 存放，重复导入自动去重；
 *  - 只存在本地 `<cobrowseDir>/assets/`，**不做任何上传**；上传必须由调用方另行取得同意；
 *  - 元数据只记事实（名字/类型/字节数/尺寸/时间/来源），不做推断。
 *
 * 尺寸解析刻意不依赖 Electron（node 测试可直接跑）：PNG / JPEG / GIF 手写头部解析。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export interface AssetEntry {
  id: string
  sha256: string
  /** 原始文件名（清洗后），仅用于展示与导出命名。 */
  name: string
  mime: string
  bytes: number
  width?: number
  height?: number
  importedAt: number
  /** 调用方声明的来源（URL / 用户导入 / agent），只做记录。 */
  source?: string
}

export interface AssetIndexFile {
  version: 1
  assets: AssetEntry[]
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json'
}

export function mimeForName(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
}

export function sanitizeAssetName(raw: string): string {
  const base = path.basename(raw).replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim()
  const name = base.replace(/^\.+/, '')
  return (name || 'asset').slice(0, 120)
}

export function assetIdFor(sha256: string): string {
  return `a-${sha256.slice(0, 16)}`
}

/** 从图片字节解析尺寸；不认识的格式返回 undefined（不编造）。 */
export function imageSize(buffer: Buffer): { width: number; height: number } | undefined {
  // PNG：8 字节签名 + IHDR（宽高在偏移 16/20）
  if (buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  // GIF：GIF87a/GIF89a，宽高是小端 16 位
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  // JPEG：扫描 SOFn 段
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = buffer[offset + 1]
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2
        continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      // SOF0..SOF15（排除 DHT c4 / JPG c8 / DAC cc）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      offset += 2 + length
    }
  }
  return undefined
}

export class AssetStore {
  private root: string
  private indexFile: string
  private entries: AssetEntry[] | null = null

  constructor(root: string) {
    this.root = root
    this.indexFile = path.join(root, 'assets.json')
  }

  private load(): AssetEntry[] {
    if (this.entries) return this.entries
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as AssetIndexFile
      this.entries = Array.isArray(parsed.assets) ? parsed.assets : []
    } catch {
      this.entries = []
    }
    return this.entries
  }

  private save(): void {
    fs.mkdirSync(this.root, { recursive: true })
    const data: AssetIndexFile = { version: 1, assets: this.load() }
    const tmp = `${this.indexFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, this.indexFile)
  }

  list(): AssetEntry[] {
    return [...this.load()].sort((a, b) => b.importedAt - a.importedAt)
  }

  get(id: string): AssetEntry | null {
    return this.load().find((entry) => entry.id === id) ?? null
  }

  /** 资产文件的绝对路径；条目存在但文件丢了返回 null（不返回不存在的路径）。 */
  filePath(id: string): string | null {
    const entry = this.get(id)
    if (!entry) return null
    const file = path.join(this.root, this.fileName(entry))
    return fs.existsSync(file) ? file : null
  }

  /** 导入文件；同内容（sha256）只保留一份，返回既有条目。 */
  importFile(
    filePath: string,
    options: { name?: string; source?: string; importedAt?: number } = {}
  ): AssetEntry {
    const buffer = fs.readFileSync(filePath)
    const name = sanitizeAssetName(options.name ?? path.basename(filePath))
    return this.importBuffer(buffer, {
      name,
      mime: mimeForName(name),
      source: options.source ?? filePath,
      importedAt: options.importedAt
    })
  }

  importBuffer(
    buffer: Buffer,
    options: { name: string; mime?: string; source?: string; importedAt?: number }
  ): AssetEntry {
    if (buffer.length === 0) throw new Error('资产为空')
    if (buffer.length > 64 * 1024 * 1024) throw new Error('资产超过 64 MB 上限')
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    const existing = this.load().find((entry) => entry.sha256 === sha256)
    if (existing) return existing
    const name = sanitizeAssetName(options.name)
    const entry: AssetEntry = {
      id: assetIdFor(sha256),
      sha256,
      name,
      mime: options.mime ?? mimeForName(name),
      bytes: buffer.length,
      importedAt: options.importedAt ?? Date.now(),
      ...(options.source ? { source: options.source } : {}),
      ...(() => {
        const size = imageSize(buffer)
        return size ? { width: size.width, height: size.height } : {}
      })()
    }
    fs.mkdirSync(this.root, { recursive: true })
    fs.writeFileSync(path.join(this.root, this.fileName(entry)), buffer)
    this.load().push(entry)
    this.save()
    return entry
  }

  /** 设计服务导出时使用的别名（与 copyTo 同义）。 */
  copy(id: string, targetDir: string): string | null {
    return this.copyTo(id, targetDir)
  }

  /** 导出用：把资产复制到目标目录，返回相对文件名。 */
  copyTo(id: string, targetDir: string): string | null {
    const entry = this.get(id)
    const source = this.filePath(id)
    if (!entry || !source) return null
    fs.mkdirSync(targetDir, { recursive: true })
    const targetName = this.fileName(entry)
    fs.copyFileSync(source, path.join(targetDir, targetName))
    return targetName
  }

  private fileName(entry: AssetEntry): string {
    const ext = path.extname(entry.name).toLowerCase() || '.bin'
    return `${entry.id}${ext}`
  }
}
