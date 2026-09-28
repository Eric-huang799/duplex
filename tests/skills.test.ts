import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __setRootsForTest,
  importSkillFromFolder,
  listSkillFiles,
  listSkills,
  readSkillFile,
  readSkillMarkdown,
  removeSkill,
  setSkillEnabled,
  skillsPromptSection
} from '../src/main/agent/skills'
import { createSkillToolHandlers, type ScriptConfirmFn } from '../src/main/agent/skill-tools'
import type { ToolResult } from '../src/main/tool-handlers'

function writeFixture(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

const toolText = (result: ToolResult): string =>
  result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')

function recordingConfirm(approved: boolean): {
  confirm: ScriptConfirmFn
  calls: Parameters<ScriptConfirmFn>[0][]
} {
  const calls: Parameters<ScriptConfirmFn>[0][] = []
  const confirm: ScriptConfirmFn = async (payload) => {
    calls.push(payload)
    return approved
  }
  return { confirm, calls }
}

let tmpRoot: string
let duplexRoot: string
let claudeRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-skills-'))
  duplexRoot = path.join(tmpRoot, 'duplex-skills')
  claudeRoot = path.join(tmpRoot, 'claude-skills')
  fs.mkdirSync(duplexRoot, { recursive: true })
  fs.mkdirSync(claudeRoot, { recursive: true })

  writeFixture(
    path.join(claudeRoot, 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: "Alpha test skill"\n---\n\n# Alpha\n\nBody A\n'
  )
  writeFixture(path.join(claudeRoot, 'beta', 'SKILL.md'), '# Beta\n\nNo frontmatter here.\n')
  writeFixture(path.join(claudeRoot, 'beta', 'notes', 'info.txt'), 'beta note\n')
  writeFixture(
    path.join(claudeRoot, 'beta', 'scripts', 'echo.js'),
    [
      "const args = process.argv.slice(2)",
      "console.log('echo:' + args.join(','))",
      "console.error('stderr-line')",
      ''
    ].join('\n')
  )
  writeFixture(
    path.join(claudeRoot, 'pkg', '.claude', 'skills', 'nested', 'SKILL.md'),
    '---\nname: nested\n---\n\n# Nested\n'
  )

  __setRootsForTest(duplexRoot, claudeRoot)
})

afterEach(() => {
  __setRootsForTest()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('listSkills', () => {
  it('scans both roots recursively and parses frontmatter', () => {
    const skills = listSkills()
    const ids = skills.map((s) => s.id)
    expect(ids).toContain('claude/alpha')
    expect(ids).toContain('claude/beta')
    expect(ids).toContain('claude/nested')

    const alpha = skills.find((s) => s.id === 'claude/alpha')
    expect(alpha).toMatchObject({
      name: 'alpha',
      description: 'Alpha test skill',
      source: 'claude',
      enabled: true,
      dir: path.join(claudeRoot, 'alpha')
    })

    const beta = skills.find((s) => s.id === 'claude/beta')
    expect(beta).toMatchObject({ name: 'beta', description: '', source: 'claude' })

    const nested = skills.find((s) => s.id === 'claude/nested')
    expect(nested?.dir).toBe(path.join(claudeRoot, 'pkg', '.claude', 'skills', 'nested'))
  })

  it('keeps same-name skills from different sources', () => {
    writeFixture(path.join(duplexRoot, 'beta', 'SKILL.md'), '---\nname: beta\n---\n\n# DuplexB\n')
    const betas = listSkills().filter((s) => s.name === 'beta')
    expect(betas.map((s) => s.id).sort()).toEqual(['claude/beta', 'duplex/beta'])
  })
})

describe('skill enabled state', () => {
  it('persists disabled ids in skill-state.json next to the duplex root', () => {
    setSkillEnabled('claude/alpha', false)
    expect(listSkills().find((s) => s.id === 'claude/alpha')?.enabled).toBe(false)

    const statePath = path.join(path.dirname(duplexRoot), 'skill-state.json')
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({ disabled: ['claude/alpha'] })

    setSkillEnabled('claude/alpha', true)
    expect(listSkills().find((s) => s.id === 'claude/alpha')?.enabled).toBe(true)
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({ disabled: [] })
  })

  it('treats corrupt state as all-enabled', () => {
    fs.writeFileSync(path.join(path.dirname(duplexRoot), 'skill-state.json'), '{not json', 'utf8')
    expect(listSkills().every((s) => s.enabled)).toBe(true)
  })
})

describe('reading skills', () => {
  it('reads SKILL.md content', () => {
    const result = readSkillMarkdown('claude/alpha')
    expect(result.ok).toBe(true)
    expect(result.content).toContain('# Alpha')
    expect(readSkillMarkdown('missing').ok).toBe(false)
  })

  it('lists files recursively with relative paths', () => {
    const result = listSkillFiles('beta')
    expect(result.ok).toBe(true)
    expect(result.files).toContain('SKILL.md')
    expect(result.files).toContain('notes/info.txt')
    expect(result.files).toContain('scripts/echo.js')
    for (const file of result.files ?? []) expect(path.isAbsolute(file)).toBe(false)
  })

  it('reads a file by relative path', () => {
    const result = readSkillFile('claude/beta', 'notes/info.txt')
    expect(result.ok).toBe(true)
    expect(result.content).toBe('beta note\n')
  })

  it('rejects path traversal and absolute paths', () => {
    writeFixture(path.join(tmpRoot, 'secret.txt'), 'secret')
    expect(readSkillFile('claude/beta', '../secret.txt').ok).toBe(false)
    expect(readSkillFile('claude/beta', '..\\secret.txt').ok).toBe(false)
    expect(readSkillFile('claude/beta', path.join(tmpRoot, 'secret.txt')).ok).toBe(false)
    expect(readSkillFile('claude/beta', 'nope.txt').ok).toBe(false)
  })

  it('rejects text files over 200KB', () => {
    writeFixture(path.join(claudeRoot, 'beta', 'big.txt'), 'x'.repeat(201 * 1024))
    const result = readSkillFile('claude/beta', 'big.txt')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('200KB')
  })
})

describe('importSkillFromFolder / removeSkill', () => {
  it('imports a folder into the duplex root', () => {
    const src = path.join(tmpRoot, 'src-import')
    writeFixture(path.join(src, 'SKILL.md'), '---\nname: imported\ndescription: Imported skill\n---\n\n# Imported\n')
    writeFixture(path.join(src, 'extra', 'a.txt'), 'a')

    const result = importSkillFromFolder(src)
    expect(result.ok).toBe(true)
    expect(result.id).toBe('duplex/imported')
    expect(fs.existsSync(path.join(duplexRoot, 'imported', 'extra', 'a.txt'))).toBe(true)
    expect(listSkills().find((s) => s.id === 'duplex/imported')?.enabled).toBe(true)

    const again = importSkillFromFolder(src)
    expect(again.ok).toBe(false)
    expect(again.error).toContain('已存在')
  })

  it('rejects folders without SKILL.md and missing folders', () => {
    const src = path.join(tmpRoot, 'empty-src')
    fs.mkdirSync(src, { recursive: true })
    expect(importSkillFromFolder(src).ok).toBe(false)
    expect(importSkillFromFolder(path.join(tmpRoot, 'nope')).ok).toBe(false)
  })

  it('removes only duplex skills', () => {
    const src = path.join(tmpRoot, 'src-remove')
    writeFixture(path.join(src, 'SKILL.md'), '---\nname: removable\n---\n\n# R\n')
    expect(importSkillFromFolder(src).ok).toBe(true)
    setSkillEnabled('duplex/removable', false)

    expect(removeSkill('duplex/removable')).toEqual({ ok: true })
    expect(listSkills().some((s) => s.id === 'duplex/removable')).toBe(false)

    expect(removeSkill('claude/alpha').ok).toBe(false)
    expect(removeSkill('missing').ok).toBe(false)
  })
})

describe('skillsPromptSection', () => {
  it('lists enabled skills as "name: description"', () => {
    const section = skillsPromptSection()
    expect(section).toContain('- alpha: Alpha test skill')
    expect(section).toContain('- beta')
  })

  it('omits disabled skills and returns empty when none are enabled', () => {
    for (const skill of listSkills()) setSkillEnabled(skill.id, false)
    expect(skillsPromptSection()).toBe('')
  })
})

describe('createSkillToolHandlers', () => {
  it('exposes exactly the four skill tools', () => {
    const handlers = createSkillToolHandlers(async () => true)
    expect(Object.keys(handlers).sort()).toEqual([
      'list_skill_files',
      'read_skill',
      'read_skill_file',
      'run_skill_script'
    ])
  })

  it('read_skill returns SKILL.md with an id header and looks up by name or id', async () => {
    const handlers = createSkillToolHandlers(async () => true)
    const byName = await handlers.read_skill({ name: 'alpha' })
    expect(toolText(byName)).toContain('Skill: claude/alpha')
    expect(toolText(byName)).toContain('Body A')
    const byId = await handlers.read_skill({ name: 'claude/beta' })
    expect(toolText(byId)).toContain('No frontmatter here.')
    expect((await handlers.read_skill({ name: 'missing' })).isError).toBe(true)
  })

  it('reads and lists skill files through the handlers', async () => {
    const handlers = createSkillToolHandlers(async () => true)
    const listed = await handlers.list_skill_files({ name: 'beta' })
    expect(toolText(listed)).toContain('scripts/echo.js')
    const read = await handlers.read_skill_file({ name: 'beta', path: 'notes/info.txt' })
    expect(toolText(read)).toBe('beta note\n')
    const escaped = await handlers.read_skill_file({ name: 'beta', path: '../secret.txt' })
    expect(escaped.isError).toBe(true)
  })

  it('refuses to run a script when the user denies confirmation', async () => {
    const { confirm, calls } = recordingConfirm(false)
    const handlers = createSkillToolHandlers(confirm)
    const result = await handlers.run_skill_script({
      name: 'beta',
      script: 'scripts/echo.js',
      args: ['a']
    })
    expect(result.isError).toBeFalsy()
    expect(toolText(result)).toContain('用户拒绝执行该脚本')
    expect(calls).toHaveLength(1)
    expect(calls[0].cwd).toBe(path.join(claudeRoot, 'beta'))
    expect(calls[0].skill).toBe('claude/beta')
    expect(calls[0].command).toContain('node')
    expect(calls[0].command).toContain('scripts')
  })

  it('executes an approved script and captures combined output', async () => {
    const { confirm, calls } = recordingConfirm(true)
    const handlers = createSkillToolHandlers(confirm)
    const result = await handlers.run_skill_script({
      name: 'claude/beta',
      script: 'scripts/echo.js',
      args: ['a', 'b']
    })
    const out = toolText(result)
    expect(result.isError).toBeFalsy()
    expect(out).toContain('exit code: 0')
    expect(out).toContain('echo:a,b')
    expect(out).toContain('stderr-line')
    expect(calls).toHaveLength(1)
  })

  it('rejects traversal, missing and unsupported scripts without confirming', async () => {
    const { confirm, calls } = recordingConfirm(true)
    const handlers = createSkillToolHandlers(confirm)

    const traversal = await handlers.run_skill_script({ name: 'beta', script: '../escape.js' })
    expect(traversal.isError).toBe(true)
    const missing = await handlers.run_skill_script({ name: 'beta', script: 'scripts/nope.js' })
    expect(missing.isError).toBe(true)
    const unsupported = await handlers.run_skill_script({ name: 'beta', script: 'notes/info.txt' })
    expect(unsupported.isError).toBe(true)
    const unknown = await handlers.run_skill_script({ name: 'missing', script: 'scripts/echo.js' })
    expect(unknown.isError).toBe(true)

    expect(calls).toHaveLength(0)
  })
})
