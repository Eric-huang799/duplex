import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd()
  },
  dialog: {
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] })
  },
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined,
    on: () => undefined,
    removeAllListeners: () => undefined
  }
}))

import {
  parseFeatureManifestJson,
  validateFeatureManifest,
  type FeatureManifest
} from '../src/shared/features'
import { FeatureHost, type BuiltinFeature, type FeatureHostDeps } from '../src/main/features/host'
import { createDesignFeature } from '../src/main/features/design-canvas'
import { removeTestDir } from './fs-cleanup'

function manifest(overrides: Partial<FeatureManifest> = {}): FeatureManifest {
  return {
    id: 'demo',
    name: 'Demo feature',
    version: '1.0.0',
    description: '测试用功能插件',
    contributes: {},
    ...overrides
  }
}

function externalManifest(id: string, extra: Partial<FeatureManifest> = {}): FeatureManifest {
  return manifest({
    id,
    name: `Plugin ${id}`,
    contributes: {
      toolbar: [{ id: 'ping', label: 'Ping', command: `${id}.ping` }],
      tools: [`${id}_echo`]
    },
    ...extra
  })
}

function writeExternalPlugin(
  root: string,
  id: string,
  options: { activateFails?: boolean } = {}
): string {
  const dir = path.join(root, 'features', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(externalManifest(id), null, 2))
  const failLine = options.activateFails ? `throw new Error('boom from ${id}')` : ''
  fs.writeFileSync(
    path.join(dir, 'index.mjs'),
    [
      "import fs from 'node:fs'",
      'export function activate(ctx) {',
      `  ${failLine}`,
      `  ctx.registerCommand('${id}.ping', (args) => ({ pong: args.n ?? 1, caller: ctx.caller() }))`,
      `  ctx.registerToolHandler('${id}_echo', (args) => ({`,
      `    content: [{ type: 'text', text: 'echo:' + (args.text ?? '') }]`,
      '  }))',
      `  return () => { fs.writeFileSync(new URL('./deactivated.txt', import.meta.url), 'yes') }`,
      '}'
    ].join('\n'),
    'utf8'
  )
  return dir
}

function toolResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function demoBuiltin(state: { deactivated: number }): BuiltinFeature {
  return {
    manifest: manifest({
      contributes: {
        toolbar: [{ id: 'say', label: 'Say', icon: '✦', command: 'demo.say' }],
        tools: ['demo_echo'],
        statusCard: true
      }
    }),
    activate(ctx) {
      ctx.registerCommand('demo.say', (args) => ({
        said: args['text'] ?? 'hi',
        caller: ctx.caller()
      }))
      ctx.registerToolHandler('demo_echo', (args) =>
        toolResult(`echo:${String(args['text'] ?? '')}`)
      )
      ctx.setStatus({
        text: 'ready',
        tone: 'ok',
        actions: [{ id: 'say', label: 'Say', command: 'demo.say' }]
      })
      return {
        deactivate: () => {
          state.deactivated += 1
        }
      }
    }
  }
}

let root: string
let hosts: FeatureHost[]
let changes: number

function makeHost(overrides: Partial<FeatureHostDeps> = {}): FeatureHost {
  const host = new FeatureHost({
    dir: root,
    win: () => null,
    log: () => undefined,
    caller: () => 'test-agent',
    openCanvasTab: () => null,
    onChange: () => {
      changes += 1
    },
    ...overrides
  })
  hosts.push(host)
  return host
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'features-host-'))
  hosts = []
  changes = 0
})

afterEach(async () => {
  for (const host of hosts) await host.deactivateAll()
  removeTestDir(root)
})

describe('FeatureManifest 校验', () => {
  it('接受合法 manifest；重建对象并保留可选字段', () => {
    const result = validateFeatureManifest({
      id: 'design-canvas',
      name: '设计',
      version: '1.2.3',
      description: 'demo',
      contributes: {
        toolbar: [{ id: 'open', label: '打开', icon: '✦', command: 'design.open-canvas' }],
        tools: ['design_open'],
        statusCard: true
      },
      extraIgnored: true
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.id).toBe('design-canvas')
    expect(result.value.contributes.toolbar?.[0]?.icon).toBe('✦')
    expect(result.value.contributes.statusCard).toBe(true)
    expect(result.value.contributes.tools).toEqual(['design_open'])
  })

  it('拒绝非法 id / 版本 / 重复工具栏 id / 非法工具名', () => {
    expect(validateFeatureManifest(manifest({ id: 'Bad Id' })).ok).toBe(false)
    expect(validateFeatureManifest(manifest({ version: '1.0' })).ok).toBe(false)
    expect(
      validateFeatureManifest(
        manifest({
          contributes: {
            toolbar: [
              { id: 'open', label: 'A', command: 'a.open' },
              { id: 'open', label: 'B', command: 'a.open2' }
            ]
          }
        })
      ).ok
    ).toBe(false)
    expect(
      validateFeatureManifest(manifest({ contributes: { tools: ['bad tool'] } })).ok
    ).toBe(false)
    expect(
      validateFeatureManifest(manifest({ contributes: { statusCard: 'yes' as never } })).ok
    ).toBe(false)
  })

  it('JSON 语法错误与结构错误都返回 ok=false', () => {
    expect(parseFeatureManifestJson('{oops').ok).toBe(false)
    expect(parseFeatureManifestJson('null').ok).toBe(false)
    const ok = parseFeatureManifestJson(JSON.stringify(manifest()))
    expect(ok.ok).toBe(true)
  })
})

describe('FeatureHost：内置插件 / 命令 / 工具 / 状态卡', () => {
  it('激活后命令、工具、状态卡都可用，并按 caller 路由', async () => {
    const state = { deactivated: 0 }
    const host = makeHost()
    host.registerBuiltin(demoBuiltin(state))
    await host.start()

    const [info] = host.list()
    expect(info).toMatchObject({ enabled: true, builtin: true })
    expect(info.dir).toBeUndefined()
    expect(host.activeToolNames()).toContain('demo_echo')

    const command = await host.invokeCommand('demo.say', { text: 'yo' })
    expect(command).toEqual({ ok: true, result: { said: 'yo', caller: 'test-agent' } })

    const tool = await host.runTool('demo_echo', { text: 'x' })
    expect(tool).toEqual(toolResult('echo:x'))

    const status = host.statuses()
    expect(status).toHaveLength(1)
    expect(status[0]).toMatchObject({ id: 'demo', status: { text: 'ready', tone: 'ok' } })

    expect(changes).toBeGreaterThan(0)
  })

  it('禁用后命令/工具/状态卡一起消失，并持久化到 features.json', async () => {
    const state = { deactivated: 0 }
    const host = makeHost()
    host.registerBuiltin(demoBuiltin(state))
    await host.start()

    const result = await host.setEnabled('demo', false)
    expect(result.ok).toBe(true)
    expect(state.deactivated).toBe(1)
    expect(host.list()[0]?.enabled).toBe(false)
    expect(host.statuses()).toEqual([])
    expect(host.activeToolNames()).toEqual([])
    expect(host.isToolAvailable('demo_echo')).toBe(false)

    const tool = await host.runTool('demo_echo', { text: 'x' })
    expect(tool.isError).toBe(true)
    expect(tool.content[0]).toMatchObject({ type: 'text' })

    const command = await host.invokeCommand('demo.say', {}, 'demo')
    expect(command.ok).toBe(false)
    expect(command.error).toContain('未启用')

    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'features.json'), 'utf8')) as {
      enabled: Record<string, boolean>
    }
    expect(persisted.enabled['demo']).toBe(false)
  })

  it('新建宿主读取持久化状态：禁用不会激活，重新启用恢复', async () => {
    const first = makeHost()
    first.registerBuiltin(demoBuiltin({ deactivated: 0 }))
    await first.start()
    await first.setEnabled('demo', false)

    const secondState = { deactivated: 0 }
    const second = makeHost()
    second.registerBuiltin(demoBuiltin(secondState))
    await second.start()
    expect(second.list()[0]?.enabled).toBe(false)
    expect(second.activeToolNames()).toEqual([])

    const enabled = await second.setEnabled('demo', true)
    expect(enabled.ok).toBe(true)
    expect(second.activeToolNames()).toContain('demo_echo')
    expect((await second.invokeCommand('demo.say')) as { ok: boolean }).toMatchObject({ ok: true })

    await second.setEnabled('demo', false)
    expect(secondState.deactivated).toBe(1)
  })

  it('未知插件与未知命令返回可读错误，不抛出', async () => {
    const host = makeHost()
    await host.start()
    const toggle = await host.setEnabled('nope', true)
    expect(toggle.ok).toBe(false)
    expect(toggle.error).toContain('不存在')

    const command = await host.invokeCommand('nope.command')
    expect(command.ok).toBe(false)
    expect(command.error).toContain('未知')

    const tool = await host.runTool('nope_tool', {})
    expect(tool.isError).toBe(true)
    expect(JSON.stringify(tool.content)).toContain('未知功能工具')
  })

  it('内置设计插件经宿主注册：6 个设计工具、画布命令与状态卡均可启停', async () => {
    const previous = process.env['DUPLEX_DATA_DIR']
    process.env['DUPLEX_DATA_DIR'] = root
    try {
      const host = makeHost()
      host.registerBuiltin(createDesignFeature())
      await host.start()

      expect(host.activeToolNames()).toEqual(
        expect.arrayContaining([
          'design_open',
          'design_read',
          'design_patch',
          'design_variants',
          'design_commit',
          'design_export'
        ])
      )
      expect(host.statuses().map((entry) => entry.id)).toContain('design-canvas')
      // 测试宿主没有真实画布标签：命令应返回可读错误而不是抛异常。
      const open = await host.invokeCommand('design.open-canvas', {}, 'design-canvas')
      expect(open.ok).toBe(true)
      expect(open.result).toMatchObject({ ok: false })
      const undo = await host.invokeCommand('design.undo', {}, 'design-canvas')
      expect(undo.result).toMatchObject({ ok: true })

      await host.setEnabled('design-canvas', false)
      expect(host.activeToolNames()).toEqual([])
      expect(host.statuses()).toEqual([])
      const disabled = await host.runTool('design_read', {})
      expect(disabled.isError).toBe(true)
      expect(JSON.stringify(disabled.content)).toContain('已禁用')

      await host.setEnabled('design-canvas', true)
      expect(host.activeToolNames()).toContain('design_open')
    } finally {
      if (previous === undefined) delete process.env['DUPLEX_DATA_DIR']
      else process.env['DUPLEX_DATA_DIR'] = previous
    }
  })
})

describe('FeatureHost：外部插件扫描与启停', () => {
  it('扫描外部插件：默认禁用，启用后可调用命令/工具，禁用触发清理', async () => {
    writeExternalPlugin(root, 'hello')
    const host = makeHost()
    await host.start()

    const info = host.list().find((entry) => entry.manifest.id === 'hello')
    expect(info).toMatchObject({ enabled: false, builtin: false })
    expect(info?.dir).toBe(path.join(root, 'features', 'hello'))

    const disabled = await host.runTool('hello_echo', { text: 'a' })
    expect(disabled.isError).toBe(true)
    expect(JSON.stringify(disabled.content)).toContain('已禁用')

    const enabled = await host.setEnabled('hello', true)
    expect(enabled.ok).toBe(true)
    expect(await host.invokeCommand('hello.ping', { n: 7 }, 'hello')).toEqual({
      ok: true,
      result: { pong: 7, caller: 'test-agent' }
    })
    expect(await host.runTool('hello_echo', { text: 'b' })).toEqual(toolResult('echo:b'))
    expect(host.isToolAvailable('hello_echo')).toBe(true)

    await host.setEnabled('hello', false)
    expect(fs.existsSync(path.join(root, 'features', 'hello', 'deactivated.txt'))).toBe(true)
    expect(host.activeToolNames()).toEqual([])
  })

  it('外部插件启用状态跨宿主持久化', async () => {
    writeExternalPlugin(root, 'hello')
    const first = makeHost()
    await first.start()
    await first.setEnabled('hello', true)

    const second = makeHost()
    await second.start()
    expect(second.list().find((entry) => entry.manifest.id === 'hello')?.enabled).toBe(true)
    expect(second.activeToolNames()).toContain('hello_echo')
  })

  it('非法目录只记录错误，不影响其它插件', async () => {
    writeExternalPlugin(root, 'hello')
    const broken = path.join(root, 'features', 'broken')
    fs.mkdirSync(broken, { recursive: true })
    fs.writeFileSync(path.join(broken, 'manifest.json'), '{"id":"broken"}')
    const host = makeHost()
    await host.start()
    expect(host.list().map((entry) => entry.manifest.id)).toEqual(['hello'])
    expect(host.errorList().join('\n')).toContain('features/broken')
  })
})

describe('FeatureHost：安装目录', () => {
  it('复制合法插件目录到 features/<id>/ 并默认启用', async () => {
    const source = path.join(root, 'downloads', 'my-plugin')
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(externalManifest('hello'), null, 2))
    fs.writeFileSync(
      path.join(source, 'index.mjs'),
      [
        'export function activate(ctx) {',
        "  ctx.registerCommand('hello.ping', () => ({ pong: true }))",
        "  ctx.registerToolHandler('hello_echo', (args) => ({ content: [{ type: 'text', text: 'ok' }] }))",
        '}'
      ].join('\n'),
      'utf8'
    )

    const host = makeHost()
    const installed = await host.installFolder(source)
    expect(installed.ok).toBe(true)
    expect(installed.feature).toMatchObject({ enabled: true, builtin: false })
    expect(fs.existsSync(path.join(root, 'features', 'hello', 'index.mjs'))).toBe(true)
    expect(await host.invokeCommand('hello.ping')).toEqual({ ok: true, result: { pong: true } })
  })

  it('拒绝缺少 manifest / index.mjs / 非法 manifest / 重复 id / 插件目录内的源', async () => {
    const host = makeHost()
    await host.start()

    const missingManifest = path.join(root, 'src-a')
    fs.mkdirSync(missingManifest, { recursive: true })
    fs.writeFileSync(path.join(missingManifest, 'index.mjs'), 'export function activate() {}')
    expect((await host.installFolder(missingManifest)).error).toContain('manifest')

    const missingIndex = path.join(root, 'src-b')
    fs.mkdirSync(missingIndex, { recursive: true })
    fs.writeFileSync(path.join(missingIndex, 'manifest.json'), JSON.stringify(manifest()))
    expect((await host.installFolder(missingIndex)).error).toContain('index.mjs')

    const badManifest = path.join(root, 'src-c')
    fs.mkdirSync(badManifest, { recursive: true })
    fs.writeFileSync(path.join(badManifest, 'manifest.json'), '{broken')
    fs.writeFileSync(path.join(badManifest, 'index.mjs'), 'export function activate() {}')
    expect((await host.installFolder(badManifest)).error).toContain('JSON')

    const builtin = makeHost()
    builtin.registerBuiltin(demoBuiltin({ deactivated: 0 }))
    await builtin.start()
    const conflict = path.join(root, 'src-d')
    fs.mkdirSync(conflict, { recursive: true })
    fs.writeFileSync(path.join(conflict, 'manifest.json'), JSON.stringify(manifest({ id: 'demo' })))
    fs.writeFileSync(path.join(conflict, 'index.mjs'), 'export function activate() {}')
    expect((await builtin.installFolder(conflict)).error).toContain('已安装')

    writeExternalPlugin(root, 'hello')
    await host.start()
    const inside = path.join(root, 'features', 'hello')
    expect((await host.installFolder(inside)).error).toContain('不能位于')
  })

  it('activate 抛错时回滚安装目录，不留下半成品', async () => {
    const source = path.join(root, 'src-fail')
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(externalManifest('boom')))
    fs.writeFileSync(path.join(source, 'index.mjs'), "export function activate() { throw new Error('boom') }")

    const host = makeHost()
    const result = await host.installFolder(source)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('boom')
    expect(fs.existsSync(path.join(root, 'features', 'boom'))).toBe(false)
    expect(host.list().some((entry) => entry.manifest.id === 'boom')).toBe(false)
  })

  it('目标目录已存在时拒绝覆盖', async () => {
    const source = path.join(root, 'src')
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(externalManifest('hello')))
    fs.writeFileSync(path.join(source, 'index.mjs'), 'export function activate() {}')
    fs.mkdirSync(path.join(root, 'features', 'hello'), { recursive: true })
    fs.writeFileSync(path.join(root, 'features', 'hello', 'keep.txt'), 'keep')

    const host = makeHost()
    const result = await host.installFolder(source)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('已存在')
    expect(fs.readFileSync(path.join(root, 'features', 'hello', 'keep.txt'), 'utf8')).toBe('keep')
  })
})
