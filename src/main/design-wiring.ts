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
import { DesignService, registerDesignIpc } from './design'
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
  dispose: () => void
}

export function createDesignWiring(deps: DesignWiringDeps): DesignWiring {
  const service = new DesignService()
  let canvas: WebContents | null = null
  let projectId = DEFAULT_PROJECT
  let lastRejected: Array<{ index: number; reason: string }> = []

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

  // 服务事件 → 画布消息（形状不同，必须适配；patch 事件带 ops 以便页面做增量动画）
  service.setEmit((event) => {
    if (event.type === 'document') {
      sendDocument(event.document)
      sendState()
    } else if (event.type === 'state') {
      sendState()
    } else if (event.type === 'rejected') {
      lastRejected = event.rejected
      deps.log(`[design] ${event.actor} 的 patch 被拒绝：${event.rejected.map((r) => r.reason).join('；')}`)
    }
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
      sendDocument(result.doc)
      sendState('system')
    }
  }
  ensureStarter()
  const apply = (
    actor: string,
    ops: PatchOp[],
    options: { allowLocked: boolean }
  ): { ok: boolean; error?: string } => {
    const result = service.applyOps(actor, ops, options)
    if (result.rejected.length > 0) {
      lastRejected = result.rejected
    }
    // 即使部分被拒也刷新页面：已生效的操作要立刻可见
    if (result.applied > 0) {
      send({ type: 'patch', ops, doc: result.doc })
      sendState(actor)
    }
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
          apply('user', [{ op: 'update', targetId: id, patch: patch as never }], { allowLocked: true })
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
        case 'variant-choose': {
          const blockId = String(message['blockId'] ?? '')
          const index = Number(message['index'] ?? -1)
          if (!blockId || index < 0) return
          const doc = service.chooseVariant(blockId, index)
          sendDocument(doc)
          return
        }
        case 'undo': {
          if (service.undo()) {
            sendDocument(service.current())
            sendState()
          }
          return
        }
        case 'redo': {
          if (service.redo()) {
            sendDocument(service.current())
            sendState()
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
          sendState()
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
      projectId = requested
      sendDocument(service.open(projectId))
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
      const raw = args['ops']
      if (!Array.isArray(raw)) return errorText('ops 必须是数组')
      const actor = deps.caller()
      const result = service.applyOps(actor, raw as PatchOp[], { allowLocked: false })
      sendDocument(result.doc)
      sendState(actor)
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
      const blockId = typeof args['blockId'] === 'string' ? String(args['blockId']) : ''
      const options = Array.isArray(args['options']) ? (args['options'] as DesignNode[]) : []
      if (!blockId) return errorText('缺少 blockId')
      if (options.length < 2) return errorText('至少提供 2 个变体')
      service.setVariants(blockId, options)
      send({ type: 'variants', blockId, options })
      return text(`已把 ${options.length} 个方案发给画布，等待设计师选择（区块 ${blockId}）。`)
    }
    if (name === 'design_commit') {
      const summary = typeof args['summary'] === 'string' ? String(args['summary']) : '设计轮次'
      const outcome = service.commitRound(summary)
      sendState()
      if (!outcome.ok) return errorText(`提交失败：${outcome.error ?? '未知错误'}`)
      if (outcome.skipped) return text('本轮没有改动，未产生提交。')
      return text(`已提交 ${outcome.sha?.slice(0, 7)}：${summary}`)
    }
    if (name === 'design_export') {
      const target = path.join(appDownloads(), `${projectId}-design-${Date.now().toString(36)}.zip`)
      const outcome = service.exportZip(target)
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

  return {
    service,
    canvasContents: () => canvas,
    runTool,
    dispose: () => {
      disposeIpc()
      ipcMain.removeAllListeners('design:canvas-ready')
      ipcMain.removeAllListeners('design:canvas-msg')
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
