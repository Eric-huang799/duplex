/**
 * 设计画布的主进程接线（index.ts 保持薄，逻辑集中在这里）。
 *
 * 职责：
 *  - 创建 `DesignService`（文档 + git 轮次 + 撤销）；
 *  - 把服务事件**适配**成画布页面要的形状（`src/canvas/host.ts` 的 InboundMessage）；
 *  - 处理画布发来的用户动作：拖拽/定位 → patch + 约束；锁定；撤销；提交；导出；
 *  - agent 侧 `design_*` 工具的实现。
 *
 * 关键约定：
 *  - 用户动作 `allowLocked: true`（用户自己可以改锁定区），agent 一律 false；
 *  - 坐标一律是**设计帧坐标**，`x/y` 写在 `style` 里，渲染器负责绝对定位。
 */
import path from 'node:path'
import { dialog, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { DesignService, registerDesignIpc, type DesignServiceEvent } from './design'
import {
  applyPatch,
  findNode,
  moveDelta,
  type DesignDocument,
  type DesignNode,
  type PatchOp,
  type Rect
} from '../shared/design/model'
import type { ToolResult } from './tool-handlers'
import {
  validateApplyPayload,
  validatePatchOps,
  validateProjectId,
  validateSetVariantsPayload
} from './design/validate'

interface CanvasMessage {
  type?: string
  [key: string]: unknown
}

export interface DesignWiringDeps {
  win: () => BrowserWindow | null
  log: (message: string) => void
  /** 当前 caller（agent 的身份）；用户动作固定 user。 */
  caller: () => string
  /** 打开画布标签并返回它的 webContents。 */
  openCanvas: () => WebContents | null
  /** 本地资产库：导出时把图片复制进 site/assets（可选）。 */
  assets?: { copy(id: string, targetDir: string): string | null }
  /**
   * 服务事件旁路观察者（功能宿主用它刷新状态卡）。
   * 不改变事件适配/发布路径，只是额外通知一次。
   */
  onEvent?: (event: DesignServiceEvent) => void
}

const DEFAULT_PROJECT = 'design-1'

function text(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

function errorText(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function round(n: unknown): number {
  return Math.round(Number(n) || 0)
}

export interface DesignWiring {
  service: DesignService
  canvasContents: () => WebContents | null
  /** agent 工具入口（design_open / design_read / design_patch / design_commit / design_export）。 */
  runTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
  /** 画布上的撤销/重做（菜单快捷键由主进程拦截后调用这里）。 */
  shortcut: (action: 'undo' | 'redo') => void
  dispose: () => void
}

export function createDesignWiring(deps: DesignWiringDeps): DesignWiring {
  const service = new DesignService()
  let canvas: WebContents | null = null
  let projectId = DEFAULT_PROJECT

  const send = (payload: unknown): void => {
    const wc = canvas
    if (!wc || wc.isDestroyed()) return
    try {
      wc.send('design:canvas-event', payload)
    } catch {
      /* 画布标签已关闭 */
    }
  }

  const sendDocument = (doc: DesignDocument): void => send({ type: 'document', doc })
  const sendState = (actor = 'user'): void => {
    const state = service.state()
    send({ type: 'state', round: state.version, dirty: state.dirty, actor })
  }

  // document 与 state 分别只转发一次；不要在调用方再补发，否则会重复整页渲染。
  service.setEmit((event) => {
    if (event.type === 'document') {
      sendDocument(event.document)
    } else if (event.type === 'state') {
      sendState(event.actor)
    } else if (event.type === 'rejected') {
      deps.log(`[design] ${event.actor} 的 patch 被拒绝：${event.rejected.map((r) => r.reason).join('；')}`)
    }
    deps.onEvent?.(event)
  })

  service.open(projectId)

  /**
   * 首次打开给一个可读的起点，而不是空白帧。
   *
   * 空画布会让"设计工具能用"这件事看起来像坏了；同时它也是给 agent 的示例结构：
   * 首屏 + 三张特性卡，全部用 tokens，坐标/尺寸都可被用户直接拖拽。
   */
  const ensureStarter = (): void => {
    const doc = service.current()
    if ((doc.root.children ?? []).length > 0) return
    const ops: PatchOp[] = [
      {
        op: 'insert',
        parentId: 'root',
        node: {
          id: 'hero',
          type: 'stack',
          style: {
            padding: '96px 72px',
            gap: '24px',
            background: 'linear-gradient(135deg, #eef4ff 0%, #ffffff 60%)'
          },
          children: [
            {
              id: 'hero-eyebrow',
              type: 'text',
              text: 'DUPLEX · 设计画布',
              style: { color: 'brand.primary', fontSize: '13px', letterSpacing: '0.14em' }
            },
            {
              id: 'hero-title',
              type: 'heading',
              text: '和 AI 一起，把想法变成页面',
              style: { fontSize: '56px', lineHeight: '1.08', maxWidth: '760px' }
            },
            {
              id: 'hero-body',
              type: 'text',
              text: '左侧拖拽、点选定位，右侧 agent 按 patch 流生成。每个中间态都是完整界面。',
              style: { color: 'text.muted', fontSize: '18px', maxWidth: '620px' }
            },
            {
              id: 'hero-cta',
              type: 'button',
              text: '开始设计',
              style: {
                background: 'brand.primary',
                color: 'brand.on',
                padding: '12px 22px',
                borderRadius: 'radius.md',
                alignSelf: 'flex-start'
              }
            }
          ]
        }
      },
      {
        op: 'insert',
        parentId: 'root',
        node: {
          id: 'features',
          type: 'grid',
          style: { gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px', padding: '48px 72px' },
          children: [
            {
              id: 'card-a',
              type: 'box',
              style: { padding: '24px', borderRadius: 'radius.md', border: '1px solid line.soft' },
              children: [
                { id: 'card-a-title', type: 'text', text: '看得见的过程', style: { fontWeight: '600' } },
                { id: 'card-a-body', type: 'text', text: 'patch 事务性应用，不会出现半成品。', style: { color: 'text.muted' } }
              ]
            },
            {
              id: 'card-b',
              type: 'box',
              style: { padding: '24px', borderRadius: 'radius.md', border: '1px solid line.soft' },
              children: [
                { id: 'card-b-title', type: 'text', text: '精确到像素', style: { fontWeight: '600' } },
                { id: 'card-b-body', type: 'text', text: '九点锚点 + 8px 网格吸附 + 数值微调。', style: { color: 'text.muted' } }
              ]
            },
            {
              id: 'card-c',
              type: 'box',
              style: { padding: '24px', borderRadius: 'radius.md', border: '1px solid line.soft' },
              children: [
                { id: 'card-c-title', type: 'text', text: '可回退', style: { fontWeight: '600' } },
                { id: 'card-c-body', type: 'text', text: '每轮进 git，撤销到元素级。', style: { color: 'text.muted' } }
              ]
            }
          ]
        }
      }
    ]
    const result = service.applyOps('system', ops, { allowLocked: false })
    if (result.applied > 0) {
      deps.log(`[design] 已创建初始画布：${result.applied} 个节点`)
      // 新用户一进门就背"未保存"债会焦虑；初始示例自动保存成一版。
      if (service.history(1).length === 0) {
        const saved = service.commitRound('初始示例页面')
        if (saved.ok) deps.log('[design] 初始示例已自动保存')
      }
    }
  }
  ensureStarter()
  const apply = (
    actor: string,
    ops: PatchOp[],
    options: { allowLocked: boolean }
  ): { ok: boolean; error?: string } => {
    const result = service.applyOps(actor, ops, options)
    // service 已发布最终 document/state；这里不能再把含被拒绝项的原始 ops 发给画布。
    return { ok: result.applied > 0, error: result.rejected.map((r) => r.reason).join('；') || undefined }
  }

  /** 把"锚点对齐到目标点"转成 style.x / style.y（帧内绝对定位）。 */
  const moveTo = (id: string, anchor: string, target: { x: number; y: number }, rect: Rect | undefined, frameWidth: number): void => {
    const doc = service.current()
    const node = findNode(doc.root, id)
    if (!node) return
    let nextX = round(target.x)
    let nextY = round(target.y)
    if (rect) {
      const delta = moveDelta(rect, anchor as never, target)
      nextX = round(rect.x + delta.x)
      nextY = round(rect.y + delta.y)
    }
    const ops: PatchOp[] = [
      {
        op: 'update',
        targetId: id,
        patch: {
          style: {
            ...(node.style ?? {}),
            position: 'absolute',
            x: String(nextX),
            y: String(nextY)
          }
        }
      }
    ]
    apply('user', ops, { allowLocked: true })
    service.addConstraint({
      kind: 'move',
      targetId: id,
      target: { anchor: anchor as never, point: target, frameWidth },
      createdBy: 'user'
    })
    deps.log(`[design] 用户把 ${id} 移到 (${nextX}, ${nextY})，帧宽 ${frameWidth}`)
  }

  const handleCanvasMessage = (message: CanvasMessage): void => {
    const type = typeof message['type'] === 'string' ? message['type'] : ''
    try {
      switch (type) {
        case 'user-move': {
          const id = String(message['id'] ?? '')
          const anchor = String(message['anchor'] ?? 'center')
          const target = message['target'] as { x: number; y: number } | undefined
          const rect = message['rect'] as Rect | undefined
          const frameWidth = Number(message['frameWidth'] ?? 1440)
          if (!id || !target) return
          moveTo(id, anchor, target, rect, frameWidth)
          return
        }
        case 'user-locate': {
          const id = String(message['targetId'] ?? '')
          const anchor = String(message['anchor'] ?? 'center')
          const point = message['point'] as { x: number; y: number } | undefined
          const frameWidth = Number(message['frameWidth'] ?? 1440)
          if (!id || !point) return
          moveTo(id, anchor, point, undefined, frameWidth)
          return
        }
        case 'user-update': {
          const id = String(message['id'] ?? '')
          const patch = message['patch']
          if (!id || !patch || typeof patch !== 'object') return
          const input = validateApplyPayload({
            actor: 'user',
            ops: [{ op: 'update', targetId: id, patch }],
            allowLocked: true
          })
          if (!input.ok) {
            deps.log(`[design] 拒绝非法 user-update：${input.error}`)
            return
          }
          apply('user', input.value.ops, { allowLocked: true })
          return
        }
        case 'lock': {
          const id = String(message['id'] ?? '')
          const locked = message['locked'] === true
          if (!id) return
          apply('user', [{ op: 'update', targetId: id, patch: { meta: { locked } } }], { allowLocked: true })
          deps.log(`[design] 用户${locked ? '锁定' : '解锁'}了 ${id}`)
          return
        }
        case 'user-ops': {
          const input = validatePatchOps(message['ops'])
          if (!input.ok) {
            deps.log(`[design] 拒绝非法 user-ops：${input.error}`)
            return
          }
          if (input.value.length === 0) return
          apply('user', input.value, { allowLocked: true })
          return
        }
        case 'variant-choose': {
          const blockId = String(message['blockId'] ?? '')
          const index = Number(message['index'] ?? -1)
          if (!blockId || index < 0) return
          service.chooseVariant(blockId, index)
          return
        }
        case 'undo': {
          if (service.undo()) {
            const doc = service.current()
            // 撤销不能把画布撤成空白：空文档没有任何可操作对象，看起来就像"坏了"
            if ((doc.root.children ?? []).length === 0) ensureStarter()
          }
          return
        }
        case 'redo': {
          if (service.redo()) {
            const doc = service.current()
            if ((doc.root.children ?? []).length === 0) ensureStarter()
          }
          return
        }
        case 'commit-round': {
          const summary = String(message['summary'] ?? '').trim() || '设计轮次'
          const outcome = service.commitRound(summary)
          if (!outcome.ok) {
            deps.log(`[design] 提交失败：${outcome.error ?? '未知错误'}`)
          } else {
            deps.log(`[design] 已提交 ${outcome.sha?.slice(0, 7) ?? '(无改动)'}：${summary}`)
          }
          return
        }
        case 'export': {
          void exportDesign()
          return
        }
        case 'viewport':
        case 'select':
          return
        default:
          return
      }
    } catch (error) {
      deps.log(`[design] 处理画布消息失败：${(error as Error).message}`)
    }
  }

  const exportDesign = async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const win = deps.win()
    const defaultName = `${projectId}-design.zip`
    try {
      const picked = win
        ? await dialog.showSaveDialog(win, {
            title: '导出设计',
            defaultPath: path.join(appDownloads(), defaultName),
            filters: [{ name: 'Zip', extensions: ['zip'] }]
          })
        : { canceled: false, filePath: path.join(appDownloads(), defaultName) }
      if (picked.canceled || !picked.filePath) return { ok: false, error: '已取消' }
      const outcome = service.exportZip(picked.filePath)
      if (outcome.ok) deps.log(`[design] 已导出到 ${outcome.path ?? picked.filePath}`)
      else deps.log(`[design] 导出失败：${outcome.error ?? '未知错误'}`)
      return outcome
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  function appDownloads(): string {
    try {
      // 延迟 require 避免把 electron 的 app 拉进可测试模块
      const { app } = require('electron') as typeof import('electron')
      return app.getPath('downloads')
    } catch {
      return process.cwd()
    }
  }

  const runTool = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const requested = typeof args['projectId'] === 'string' ? String(args['projectId']).trim() : ''
    if (requested && requested !== projectId) {
      const checked = validateProjectId(requested)
      if (!checked.ok) return errorText(`projectId 无效：${checked.error}`)
      service.open(checked.value)
      projectId = checked.value
    }
    if (name === 'design_open') {
      const wc = canvas ?? deps.openCanvas()
      canvas = wc
      const doc = service.current()
      if (wc && !wc.isDestroyed()) {
        try {
          wc.send('design:canvas-event', { type: 'document', doc })
        } catch {
          /* 标签刚创建 */
        }
      }
      const projectName = typeof args['name'] === 'string' ? String(args['name']) : doc.name
      return text(
        `设计画布已打开：项目 ${projectId}（${projectName}），帧 ${doc.frame.width}×${doc.frame.height}，` +
          `版本 ${doc.version}，节点 ${countNodes(doc.root)} 个。用 design_read 拿节点 id，再用 design_patch 修改。`
      )
    }
    if (name === 'design_read') {
      const doc = service.current()
      const rootId = typeof args['rootId'] === 'string' ? String(args['rootId']) : doc.root.id
      const start = findNode(doc.root, rootId)
      if (!start) return errorText(`找不到节点 ${rootId}`)
      const depth = Math.min(Math.max(Number(args['maxDepth'] ?? 6) || 6, 1), 12)
      const lines: string[] = [
        `项目 ${doc.id}「${doc.name}」 帧 ${doc.frame.width}×${doc.frame.height} 版本 ${doc.version}`,
        `tokens: color(${Object.keys(doc.tokens.color).join(', ')})`,
        `constraints: ${doc.constraints.map((c) => `${c.kind}:${c.targetId}:${c.status}`).join(', ') || '(无)'}`
      ]
      const walk = (node: DesignNode, level: number): void => {
        if (level > depth) return
        const indent = '  '.repeat(level)
        const locked = node.meta?.locked ? ' 🔒' : ''
        const style = node.style ? Object.keys(node.style).join(',') : ''
        lines.push(
          `${indent}${node.id} <${node.type}>${locked}${node.text ? ` "${node.text.slice(0, 40)}"` : ''}${style ? ` [${style}]` : ''}`
        )
        for (const child of node.children ?? []) walk(child, level + 1)
      }
      walk(start, 0)
      return text(lines.join('\n'))
    }
    if (name === 'design_patch') {
      // agent 直接改文档时也要"看得见"：画布不在就顺手打开，避免用户对着空白等结果。
      if (!canvas || canvas.isDestroyed()) canvas = deps.openCanvas()
      const input = validatePatchOps(args['ops'])
      if (!input.ok) return errorText(`design_patch 参数无效：${input.error}`)
      const actor = deps.caller()
      const result = service.applyOps(actor, input.value, { allowLocked: false })
      if (result.applied === 0) {
        return errorText(
          `没有任何 patch 生效${result.rejected.length ? `：${result.rejected.map((r) => `#${r.index} ${r.reason}`).join('；')}` : ''}`
        )
      }
      return text(
        `已应用 ${result.applied} 条 patch${result.rejected.length ? `，${result.rejected.length} 条被拒绝：${result.rejected.map((r) => `#${r.index} ${r.reason}`).join('；')}` : ''}。新版本 ${result.doc.version}。`
      )
    }
    if (name === 'design_variants') {
      const input = validateSetVariantsPayload({ blockId: args['blockId'], options: args['options'] })
      if (!input.ok) return errorText(`design_variants 参数无效：${input.error}`)
      const { blockId, options } = input.value
      if (options.length < 2) return errorText('至少提供 2 个变体')
      service.setVariants(blockId, options)
      send({ type: 'variants', blockId, options })
      return text(`已把 ${options.length} 个方案发给画布，等待设计师选择（区块 ${blockId}）。`)
    }
    if (name === 'design_commit') {
      const summary = typeof args['summary'] === 'string' ? String(args['summary']) : '设计轮次'
      const outcome = service.commitRound(summary)
      if (!outcome.ok) return errorText(`提交失败：${outcome.error ?? '未知错误'}`)
      if (outcome.skipped) return text('本轮没有改动，未产生提交。')
      return text(`已提交 ${outcome.sha?.slice(0, 7)}：${summary}`)
    }
    if (name === 'design_export') {
      const target = path.join(appDownloads(), `${projectId}-design-${Date.now().toString(36)}.zip`)
      const outcome = service.exportZip(target, deps.assets)
      if (!outcome.ok) return errorText(`导出失败：${outcome.error ?? '未知错误'}`)
      return text(`已导出：${outcome.path ?? target}`)
    }
    return errorText(`未知的设计工具：${name}`)
  }

  const disposeIpc = registerDesignIpc({
    service,
    win: deps.win(),
    canvasContents: () => canvas,
    // 事件由上面自己的适配器发（形状与 service 原始事件不同），这里不要重复接线
    wireEvents: false
  })

  ipcMain.removeAllListeners('design:canvas-ready')
  ipcMain.removeAllListeners('design:canvas-msg')
  ipcMain.on('design:canvas-ready', (event) => {
    canvas = event.sender
    sendDocument(service.current())
    sendState()
  })
  ipcMain.on('design:canvas-msg', (_event, message: unknown) => {
    if (message && typeof message === 'object') handleCanvasMessage(message as CanvasMessage)
  })

  // 画布标签由 open-canvas 创建；这里把 sender 记下来用于主动推送
  ipcMain.handle('design:open-canvas', () => {
    const wc = deps.openCanvas()
    if (!wc) return { ok: false, error: '画布资源缺失：请先 npm run build' }
    canvas = wc
    return { ok: true }
  })

  const shortcut = (action: 'undo' | 'redo'): void => {
    const changed = action === 'undo' ? service.undo() : service.redo()
    deps.log(
      `[design] shortcut ${action} changed=${changed} canUndo=${service.canUndo()} canRedo=${service.canRedo()}`
    )
    if (!changed) return
    const doc = service.current()
    if ((doc.root.children ?? []).length === 0) ensureStarter()
  }

  return {
    service,
    canvasContents: () => canvas,
    runTool,
    shortcut,
    dispose: () => {
      disposeIpc()
      ipcMain.removeAllListeners('design:canvas-ready')
      ipcMain.removeAllListeners('design:canvas-msg')
      // registerDesignIpc 不管这个通道（它由本文件自己 handle）；不删的话插件
      // 禁用后重新启用会因"second handler"直接抛错。
      ipcMain.removeHandler('design:open-canvas')
      service.close()
    }
  }
}

function countNodes(root: DesignNode): number {
  let n = 1
  for (const child of root.children ?? []) n += countNodes(child)
  return n
}

/** 供其它模块（如时间线）复用的纯函数：把一批 op 应用到一个快照上。 */
export function previewApply(doc: DesignDocument, ops: PatchOp[], actor: string): DesignDocument {
  return applyPatch(doc, ops, { actor, step: 0, at: Date.now() }).document
}
