/**
 * 设计服务的 IPC 注册。
 *
 * 约定：
 *  - 所有 handler 都包一层 try/catch，失败统一 `{ ok: false, error }`，
 *    绝不让异常变成 unhandled rejection；
 *  - 渲染层传入的 ops 先经过 validate.ts 的结构白名单校验（重建对象、拒绝原型污染），
 *    校验通过才进 DesignService；
 *  - 导出路径由主进程 `dialog.showSaveDialog` 决定，渲染层不能指定任意路径；
 *  - 服务事件转发：主窗口 `design:event`，设计画布 `design:canvas-event`
 *    （与 src/canvas/preload.ts 暴露的 `canvasHost.on` 对齐）。
 *
 * 通道（ipcMain.handle）：
 *   design:open            (projectId)
 *   design:get             ()
 *   design:apply           ({ actor, ops, allowLocked? })
 *   design:undo            ()
 *   design:redo            ()
 *   design:state           ()
 *   design:constraint      (add: { kind, targetId, ... } / resolve: { action:'resolve', id, status, note? })
 *   design:variants-set    ({ blockId, options })
 *   design:variant-choose  ({ blockId, index })
 *   design:commit          ({ summary })
 *   design:history         ({ limit? })
 *   design:export          ()
 */
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain, type SaveDialogOptions } from 'electron'
import type { DesignService, DesignServiceEvent } from './service'
import {
  isPlainObject,
  validateApplyPayload,
  validateChooseVariantPayload,
  validateCommitPayload,
  validateConstraintInput,
  validateHistoryPayload,
  validateProjectId,
  validateResolveConstraint,
  validateSetVariantsPayload,
  type Validation
} from './validate'

export interface DesignIpcDeps {
  service: DesignService
  /** 设计画布窗口（事件走 design:canvas-event）。 */
  canvasWindow?: BrowserWindow | null
  /** 画布是 WebContentsView 时用它取 webContents（优先于 canvasWindow）。 */
  canvasContents?: () => Electron.WebContents | null
  /** 主窗口（导出对话框的父窗口；事件走 design:event）。 */
  win?: BrowserWindow | null
  /** 是否把 service 事件接到上面两个窗口；默认 true（registerDesignIpc 负责接线）。 */
  wireEvents?: boolean
}

type IpcSuccess = { ok: true } & Record<string, unknown>
type IpcFailure = { ok: false; error: string; canceled?: boolean }
type IpcReply = IpcSuccess | IpcFailure

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 把校验结果解包成值；失败时抛出（由 invoke 统一转成 {ok:false,error}）。 */
function must<T>(result: Validation<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

function resolveWindow(candidate: BrowserWindow | null | undefined): BrowserWindow | null {
  if (!candidate) return null
  try {
    return candidate.isDestroyed() ? null : candidate
  } catch {
    return null
  }
}

function sendWindow(window: BrowserWindow, channel: string, payload: unknown): void {
  try {
    if (window.isDestroyed()) return
    window.webContents.send(channel, payload)
  } catch {
    /* 窗口正在关闭 */
  }
}

/** 服务事件 → 窗口。window 尚未创建时静默丢弃，渲染层可用 design:get/state 补状态。 */
function installEventForwarding(deps: DesignIpcDeps): () => void {
  if (deps.wireEvents === false) return () => undefined
  deps.service.setEmit((event: DesignServiceEvent) => {
    // 画布是主窗口里的 WebContentsView（不是一个独立的 BrowserWindow），
    // 所以优先用调用方给的 webContents getter；没有时才回落到 canvasWindow。
    const canvasContents = deps.canvasContents?.() ?? null
    if (canvasContents && !canvasContents.isDestroyed()) {
      try {
        canvasContents.send('design:canvas-event', event)
      } catch {
        /* 画布标签已关闭 */
      }
    } else {
      const canvas = resolveWindow(deps.canvasWindow)
      if (canvas) sendWindow(canvas, 'design:canvas-event', event)
    }
    const main = resolveWindow(deps.win)
    if (main) sendWindow(main, 'design:event', event)
  })
  return () => deps.service.setEmit(undefined)
}

async function invoke(run: () => unknown | Promise<unknown>): Promise<IpcReply> {
  try {
    const value = await run()
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (record['ok'] === false) {
        return {
          ok: false,
          error: typeof record['error'] === 'string' ? record['error'] : '操作失败',
          ...(record['canceled'] === true ? { canceled: true } : {})
        }
      }
      return { ok: true, ...record }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export function registerDesignIpc(deps: DesignIpcDeps): () => void {
  const { service } = deps
  const restoreEmit = installEventForwarding(deps)

  const handlers: Array<[string, (...args: unknown[]) => unknown | Promise<unknown>]> = [
    [
      'design:open',
      (projectId) => {
        const id = must(validateProjectId(projectId))
        return { document: service.open(id), state: service.state() }
      }
    ],
    [
      'design:get',
      () => ({ document: service.current(), state: service.state() })
    ],
    [
      'design:apply',
      (payload) => {
        const input = must(validateApplyPayload(payload))
        const result = service.applyOps(input.actor, input.ops, { allowLocked: input.allowLocked })
        return {
          applied: result.applied,
          rejected: result.rejected,
          document: result.doc,
          state: service.state()
        }
      }
    ],
    [
      'design:undo',
      () => {
        const undone = service.undo()
        const state = service.state()
        return { undone, state, ...(state.projectId ? { document: service.current() } : {}) }
      }
    ],
    [
      'design:redo',
      () => {
        const redone = service.redo()
        const state = service.state()
        return { redone, state, ...(state.projectId ? { document: service.current() } : {}) }
      }
    ],
    [
      'design:state',
      () => ({ state: service.state() })
    ],
    [
      'design:constraint',
      (payload) => {
        if (!isPlainObject(payload)) throw new Error('constraint: 参数必须是对象')
        const action = payload['action']
        const looksLikeResolve =
          action === 'resolve' ||
          (action === undefined && payload['kind'] === undefined && payload['status'] !== undefined)
        if (looksLikeResolve) {
          const input = must(validateResolveConstraint(payload))
          return {
            document: service.resolveConstraint(input.id, input.status, input.note),
            state: service.state()
          }
        }
        if (action !== undefined && action !== 'add') {
          throw new Error(`constraint: 未知的 action ${String(action)}`)
        }
        // action 只是本通道的分流标记，不进约束对象本身
        const fields = { ...payload }
        delete fields['action']
        const input = must(validateConstraintInput(fields))
        return { document: service.addConstraint(input), state: service.state() }
      }
    ],
    [
      'design:variants-set',
      (payload) => {
        const input = must(validateSetVariantsPayload(payload))
        service.setVariants(input.blockId, input.options)
        return { document: service.current(), state: service.state() }
      }
    ],
    [
      'design:variant-choose',
      (payload) => {
        const input = must(validateChooseVariantPayload(payload))
        return {
          document: service.chooseVariant(input.blockId, input.index),
          state: service.state()
        }
      }
    ],
    [
      'design:commit',
      (payload) => {
        const summary = must(validateCommitPayload(payload))
        return { ...service.commitRound(summary), state: service.state() }
      }
    ],
    [
      'design:history',
      (payload) => {
        const input = must(validateHistoryPayload(payload))
        return { history: service.history(input.limit) }
      }
    ],
    [
      'design:export',
      async () => {
        const state = service.state()
        if (!state.projectId) throw new Error('尚未打开设计项目')
        const parent = resolveWindow(deps.win) ?? resolveWindow(deps.canvasWindow)
        const options: SaveDialogOptions = {
          title: '导出设计（最近一轮）',
          defaultPath: defaultExportName(state.projectId),
          filters: [{ name: 'ZIP', extensions: ['zip'] }]
        }
        const picked = parent
          ? await dialog.showSaveDialog(parent, options)
          : await dialog.showSaveDialog(options)
        if (picked.canceled || !picked.filePath) {
          return { ok: false, error: '已取消导出', canceled: true }
        }
        const target = /\.zip$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.zip`
        return { ...service.exportZip(target), state: service.state() }
      }
    ]
  ]

  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => invoke(() => handler(...args)))
  }

  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel)
    restoreEmit()
  }
}

/** 仅用于文档/测试：默认导出名给路径做一层清洗（不让项目名影响扩展名判断）。 */
export function defaultExportName(projectId: string | null): string {
  const safe = (projectId ?? 'design').replace(/[^A-Za-z0-9._-]+/g, '-')
  return path.extname(safe).toLowerCase() === '.zip' ? safe : `${safe}-design.zip`
}
