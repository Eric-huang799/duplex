/**
 * 设计工作区的持久化层（只碰注入的 root，不碰用户真实目录）。
 *
 * 目录布局：
 *   <root>/<projectId>/design.json   文档（原子写）
 *   <root>/<projectId>/site/         导出产物（可选，git 推送/导出时一并纳入）
 *   <root>/<projectId>/rounds.log    人读的轮次摘要（时间 | 摘要 | sha | 指纹）
 *
 * 两个刻意的取舍：
 *  - 损坏的 design.json **改名备份**为 `design.json.corrupt-<ts>` 再返回空文档：
 *    不静默丢数据，也避免同一份坏文件每次启动都被"重新备份"一遍。
 *  - 原子写复用 shared/atomic（tmp + fsync + rename）；临时文件名以 .tmp 结尾，
 *    正好被设计工作区的 .gitignore 忽略。
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../../shared/atomic'
import { emptyDocument, type DesignDocument, type DesignTokens } from '../../shared/design/model'
import { cobrowseDir } from '../../shared/endpoint'
import { isValidProjectId, validateProjectId } from './validate'

export interface DesignProjectSummary {
  id: string
  name: string
  version: number
  updatedAt: number
}

/** 工作区根：<cobrowseDir>/designs。测试通过参数注入临时目录。 */
export function designsRoot(): string {
  return path.join(cobrowseDir(), 'designs')
}

/** 校验并返回项目目录（拒绝 `..`、路径分隔符、Windows 保留名）。 */
export function projectDir(root: string, projectId: string): string {
  const check = validateProjectId(projectId)
  if (!check.ok) throw new Error(`项目 id 不合法：${check.error}`)
  return path.join(root, check.value)
}

export function documentPath(root: string, projectId: string): string {
  return path.join(projectDir(root, projectId), 'design.json')
}

export function roundsLogPath(root: string, projectId: string): string {
  return path.join(projectDir(root, projectId), 'rounds.log')
}

function looksLikeDocument(value: unknown): value is DesignDocument {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as Record<string, unknown>
  if (typeof doc['id'] !== 'string' || typeof doc['name'] !== 'string') return false
  if (!isFiniteNumber(doc['version']) || !isFiniteNumber(doc['updatedAt'])) return false
  const frame = doc['frame']
  if (typeof frame !== 'object' || frame === null) return false
  if (!isFiniteNumber((frame as Record<string, unknown>)['width'])) return false
  if (!isFiniteNumber((frame as Record<string, unknown>)['height'])) return false
  const root = doc['root']
  if (typeof root !== 'object' || root === null) return false
  const rootNode = root as Record<string, unknown>
  if (typeof rootNode['id'] !== 'string' || typeof rootNode['type'] !== 'string') return false
  if (!isNodeShape(root)) return false
  if (!Array.isArray(doc['constraints']) || !Array.isArray(doc['variants'])) return false
  const tokens = doc['tokens']
  if (typeof tokens !== 'object' || tokens === null) return false
  return isTokenGroups(tokens)
}

function isTokenGroups(value: unknown): value is DesignTokens {
  const groups = value as Record<string, unknown>
  for (const name of ['color', 'space', 'text', 'radius']) {
    const group = groups[name]
    if (typeof group !== 'object' || group === null || Array.isArray(group)) return false
  }
  return true
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 轻量节点形状检查（不看未知字段，保持向前兼容）：id/type 存在、children 若存在必须是数组。
 * 只用来把明显损坏的文件挡在 applyPatch 之前，不替代 validate.ts 的严格入参校验。
 */
function isNodeShape(value: unknown, depth = 0): boolean {
  if (depth > 64) return false
  if (typeof value !== 'object' || value === null) return false
  const node = value as Record<string, unknown>
  if (typeof node['id'] !== 'string' || node['id'].length === 0) return false
  if (typeof node['type'] !== 'string' || node['type'].length === 0) return false
  if (node['children'] !== undefined) {
    if (!Array.isArray(node['children'])) return false
    for (const child of node['children']) if (!isNodeShape(child, depth + 1)) return false
  }
  return true
}

/** 坏文件改名备份（不删除、不覆盖已有备份）。返回备份路径。 */
function quarantine(file: string): string {
  const stamp = Date.now()
  let target = `${file}.corrupt-${stamp}`
  for (let i = 1; fs.existsSync(target); i++) target = `${file}.corrupt-${stamp}-${i}`
  try {
    fs.renameSync(file, target)
  } catch {
    // 极少数被占用的场景：先复制保住数据，再尽量把原文件拿掉，避免无限重复备份。
    fs.copyFileSync(file, target)
    try {
      fs.unlinkSync(file)
    } catch {
      /* 下次 load 会再备份一次，但至少本次数据已保住 */
    }
  }
  return target
}

/**
 * 读取文档。不存在 → 空文档；损坏 → 备份后返回空文档。
 * 项目 id 会同时作为文档 id / 初始名称（项目与文档一一对应）。
 */
export function loadDocument(projectId: string, root: string = designsRoot()): DesignDocument {
  const file = documentPath(root, projectId)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyDocument(projectId, projectId)
    }
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (looksLikeDocument(parsed)) return parsed
  } catch {
    /* 落到下面统一备份 */
  }
  quarantine(file)
  return emptyDocument(projectId, projectId)
}

/** 原子写整份文档（先 tmp、fsync、再 rename），并确保项目目录存在。 */
export function saveDocument(
  projectId: string,
  doc: DesignDocument,
  root: string = designsRoot()
): void {
  if (!doc || typeof doc !== 'object') throw new Error('saveDocument: 文档必须是对象')
  const file = documentPath(root, projectId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
}

/** 追加一行轮次摘要（人读，不参与 git 幂等判断）。 */
export function appendRoundLog(projectId: string, line: string, root: string = designsRoot()): void {
  const file = roundsLogPath(root, projectId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`, 'utf8')
}

/**
 * 列出设计项目，按 updatedAt 倒序（同时间按 id 升序保证稳定）。
 * 损坏的 design.json 不作为读取错误：用目录名/目录 mtime 兜底，项目仍然可见。
 */
export function listProjects(root: string = designsRoot()): DesignProjectSummary[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: DesignProjectSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidProjectId(entry.name)) continue
    const id = entry.name
    const dir = path.join(root, id)
    const file = path.join(dir, 'design.json')
    let name = id
    let version = 0
    let updatedAt = 0
    try {
      updatedAt = fs.statSync(file).mtimeMs
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DesignDocument>
      if (looksLikeDocument(parsed)) {
        name = parsed.name || id
        version = parsed.version
        updatedAt = parsed.updatedAt
      }
    } catch {
      try {
        updatedAt = fs.statSync(dir).mtimeMs
      } catch {
        /* 目录刚好被删掉：跳过 */
        continue
      }
    }
    out.push({ id, name, version, updatedAt })
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  return out
}
