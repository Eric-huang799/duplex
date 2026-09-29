/**
 * Skill system: discovers Claude-Code-compatible skills (a directory that
 * contains SKILL.md with optional frontmatter and supporting files) from the
 * user's ~/.claude/skills (read-only) and Duplex's own ~/.cobrowse/skills
 * (importable/removable).
 *
 * Everything here is defensive: functions never throw and degrade to empty
 * results, because a malformed skills folder must not break the agent.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface SkillInfo {
  id: string
  name: string
  description: string
  source: 'duplex' | 'claude'
  dir: string
  enabled: boolean
}

const MAX_SCAN_DEPTH = 4
const MAX_FILES = 2000
const MAX_TEXT_BYTES = 200 * 1024

interface SkillRoots {
  duplex: string
  claude: string
}

let testRoots: SkillRoots | null = null

/**
 * Test hook: point the module at temporary roots; call without arguments to
 * restore the real home-directory roots. The skill-state file lives in the
 * parent of the duplex root, so it is redirected as well.
 */
export function __setRootsForTest(duplexRoot?: string, claudeRoot?: string): void {
  testRoots = duplexRoot && claudeRoot ? { duplex: duplexRoot, claude: claudeRoot } : null
}

function roots(): SkillRoots {
  return (
    testRoots ?? {
      duplex: path.join(os.homedir(), '.cobrowse', 'skills'),
      claude: path.join(os.homedir(), '.claude', 'skills')
    }
  )
}

function stateFilePath(): string {
  return path.join(path.dirname(roots().duplex), 'skill-state.json')
}

interface SkillState {
  disabled: string[]
}

function readState(): SkillState {
  try {
    const raw = fs.readFileSync(stateFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as { disabled?: unknown }
    return {
      disabled: Array.isArray(parsed?.disabled)
        ? parsed.disabled.filter((v): v is string => typeof v === 'string')
        : []
    }
  } catch {
    return { disabled: [] }
  }
}

function writeState(state: SkillState): void {
  try {
    fs.mkdirSync(path.dirname(stateFilePath()), { recursive: true })
    fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    /* best effort — a failed write only loses the toggle */
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function stripQuotes(value: string): string {
  const v = value.trim()
  if (v.length >= 2) {
    const first = v[0]
    const last = v[v.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1).trim()
    }
  }
  return v
}

/** Parse only the name/description keys of a leading --- frontmatter block. */
function parseFrontmatter(text: string): { name: string; description: string } {
  const result = { name: '', description: '' }
  try {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
    if (lines.length === 0 || lines[0].trim() !== '---') return result
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '---') break
      const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
      if (!match) continue
      const key = match[1].toLowerCase()
      if (key === 'name' && !result.name) result.name = stripQuotes(match[2])
      else if (key === 'description' && !result.description) {
        result.description = stripQuotes(match[2])
      }
    }
  } catch {
    /* malformed frontmatter falls back to empty fields */
  }
  return result
}

/**
 * Recursively find directories containing SKILL.md (up to MAX_SCAN_DEPTH
 * directory levels below the root, e.g. pkg/.claude/skills/nested/SKILL.md).
 */
function scanRoot(root: string, source: 'duplex' | 'claude'): Omit<SkillInfo, 'enabled'>[] {
  const found: Omit<SkillInfo, 'enabled'>[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const skillEntry = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'skill.md')
    if (depth >= 1 && skillEntry) {
      let name = path.basename(dir)
      let description = ''
      try {
        const parsed = parseFrontmatter(fs.readFileSync(path.join(dir, skillEntry.name), 'utf8'))
        if (parsed.name) name = parsed.name
        description = parsed.description
      } catch {
        /* keep the directory-name fallback */
      }
      found.push({ id: `${source}/${name}`, name, description, source, dir })
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(path.join(dir, entry.name), depth + 1)
      }
    }
  }
  walk(path.resolve(root), 0)
  return found
}

export function listSkills(): SkillInfo[] {
  try {
    const disabled = new Set(readState().disabled)
    const all = [
      ...scanRoot(roots().duplex, 'duplex'),
      ...scanRoot(roots().claude, 'claude')
    ]
    const seen = new Set<string>()
    const result: SkillInfo[] = []
    for (const skill of all) {
      // disambiguate same-name skills instead of silently dropping them
      let id = skill.id
      for (let n = 2; seen.has(id); n++) id = `${skill.id}~${n}`
      seen.add(id)
      result.push({ ...skill, id, enabled: !disabled.has(id) })
    }
    result.sort((a, b) => a.id.localeCompare(b.id))
    return result
  } catch {
    return []
  }
}

/** Look up by exact id first, then by the first matching name. */
function findSkill(idOrName: string): SkillInfo | null {
  const all = listSkills()
  return all.find((s) => s.id === idOrName) ?? all.find((s) => s.name === idOrName) ?? null
}

export function setSkillEnabled(id: string, enabled: boolean): void {
  try {
    const disabled = new Set(readState().disabled)
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    writeState({ disabled: [...disabled].sort() })
  } catch {
    /* never throw */
  }
}

export function readSkillMarkdown(id: string): { ok: boolean; content?: string; error?: string } {
  try {
    const skill = findSkill(id)
    if (!skill) return { ok: false, error: `未找到 skill：${id}` }
    return { ok: true, content: fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8') }
  } catch (err) {
    return { ok: false, error: `读取 SKILL.md 失败：${errorMessage(err)}` }
  }
}

/** Recursively list files under the skill dir as '/'-separated relative paths. */
export function listSkillFiles(id: string): { ok: boolean; files?: string[]; error?: string } {
  try {
    const skill = findSkill(id)
    if (!skill) return { ok: false, error: `未找到 skill：${id}` }
    const files: string[] = []
    const walk = (dir: string): void => {
      if (files.length >= MAX_FILES) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return
        if (entry.isSymbolicLink()) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile()) files.push(path.relative(skill.dir, full).split(path.sep).join('/'))
      }
    }
    walk(skill.dir)
    return { ok: true, files }
  } catch (err) {
    return { ok: false, error: `列出文件失败：${errorMessage(err)}` }
  }
}

/** Resolve a relative path inside dir; returns null when it escapes the dir. */
function resolveInside(dir: string, relPath: string): string | null {
  try {
    if (typeof relPath !== 'string' || relPath.trim().length === 0) return null
    if (path.isAbsolute(relPath)) return null
    const base = path.resolve(dir)
    const target = path.resolve(base, relPath)
    if (target === base) return null
    if (!target.startsWith(base + path.sep)) return null
    return target
  } catch {
    return null
  }
}

export function readSkillFile(
  id: string,
  relPath: string
): { ok: boolean; content?: string; error?: string } {
  try {
    const skill = findSkill(id)
    if (!skill) return { ok: false, error: `未找到 skill：${id}` }
    const target = resolveInside(skill.dir, relPath)
    if (!target) return { ok: false, error: `非法路径（超出 skill 目录）：${relPath}` }
    if (!fs.existsSync(target)) return { ok: false, error: `文件不存在：${relPath}` }
    const stat = fs.statSync(target)
    if (!stat.isFile()) return { ok: false, error: `不是文件：${relPath}` }
    if (stat.size > MAX_TEXT_BYTES) return { ok: false, error: `文件过大（超过 200KB）：${relPath}` }
    return { ok: true, content: fs.readFileSync(target, 'utf8') }
  } catch (err) {
    return { ok: false, error: `读取文件失败：${errorMessage(err)}` }
  }
}

function sanitizeFolderName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
}

/** Return the first symlink/junction entry found (recursively), or null. */
function findLinkEntry(dir: string, depth = 0): string | null {
  if (depth > 6) return null
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    try {
      if (fs.lstatSync(full).isSymbolicLink()) return full
      if (e.isDirectory()) {
        const hit = findLinkEntry(full, depth + 1)
        if (hit) return hit
      }
    } catch {
      /* skip */
    }
  }
  return null
}

/** Copy a skill folder into the duplex root. Fails when the target exists. */
export function importSkillFromFolder(srcDir: string): { ok: boolean; id?: string; error?: string } {
  try {
    const src = path.resolve(srcDir)
    let stat: fs.Stats
    try {
      stat = fs.statSync(src)
    } catch {
      return { ok: false, error: `来源目录不存在：${srcDir}` }
    }
    if (!stat.isDirectory()) return { ok: false, error: `来源不是目录：${srcDir}` }
    const skillMd = path.join(src, 'SKILL.md')
    if (!fs.existsSync(skillMd)) return { ok: false, error: '来源目录缺少 SKILL.md' }

    let name = path.basename(src)
    try {
      const parsed = parseFrontmatter(fs.readFileSync(skillMd, 'utf8'))
      if (parsed.name) name = parsed.name
    } catch {
      /* keep the directory name */
    }
    const folderName = sanitizeFolderName(name) || path.basename(src)
    const dest = path.join(roots().duplex, folderName)
    if (fs.existsSync(dest)) return { ok: false, error: `技能已存在：${dest}` }

    // refuse to import through symbolic links / junctions — they could pull
    // in files from outside the chosen folder (e.g. ~/.ssh)
    const linkHit = findLinkEntry(src)
    if (linkHit) {
      return { ok: false, error: `来源目录包含符号链接/联接点，已拒绝导入：${linkHit}` }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(src, dest, { recursive: true })
    const imported = listSkills().find(
      (s) => s.source === 'duplex' && path.resolve(s.dir) === path.resolve(dest)
    )
    return { ok: true, id: imported?.id ?? `duplex/${name}` }
  } catch (err) {
    return { ok: false, error: `导入失败：${errorMessage(err)}` }
  }
}

/** Remove a skill directory. Only duplex-sourced skills may be removed. */
export function removeSkill(id: string): { ok: boolean; error?: string } {
  try {
    const skill = findSkill(id)
    if (!skill) return { ok: false, error: `未找到 skill：${id}` }
    if (skill.source !== 'duplex') return { ok: false, error: '只能删除 duplex 来源的 skill' }
    fs.rmSync(skill.dir, { recursive: true, force: true })
    setSkillEnabled(skill.id, true)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `删除失败：${errorMessage(err)}` }
  }
}

/** System-prompt fragment listing enabled skills as "name: description". */
export function skillsPromptSection(): string {
  try {
    const enabled = listSkills().filter((s) => s.enabled)
    if (enabled.length === 0) return ''
    return [
      '## Skills',
      'Read a skill with read_skill before following it; inspect supporting files with list_skill_files / read_skill_file; run its scripts with run_skill_script (the user confirms each run).',
      ...enabled.map((s) => (s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`))
    ].join('\n')
  } catch {
    return ''
  }
}
