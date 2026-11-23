/**
 * 内置「设计画布」插件：把现有的 `createDesignWiring` 包装成通用宿主可加载的插件。
 *
 * 这里不做任何设计能力的重写——服务、IPC、画布消息、agent 工具仍由 design-wiring
 * 负责；本文件只负责：
 *  - 声明 manifest（工具栏按钮、6 个设计工具、对话状态卡）；
 *  - 把 wiring 暴露的能力注册成宿主命令；
 *  - 把 6 个 design_* 工具处理函数注册到宿主；
 *  - 通过 ctx.setStatus 把版本/未保存状态发布到对话卡片。
 */
import path from 'node:path'
import { app, dialog } from 'electron'
import { createDesignWiring, type DesignWiring } from '../design-wiring'
import type { DesignServiceEvent } from '../design/service'
import { mt } from '../i18n'
import type { ToolResult } from '../tool-handlers'
import type { PatchOp } from '../../shared/design/model'
import type { BuiltinFeature, FeatureContext } from './host'

export const DESIGN_FEATURE_ID = 'design-canvas'
export const DESIGN_TOOL_NAMES = [
  'design_open',
  'design_read',
  'design_patch',
  'design_variants',
  'design_commit',
  'design_export'
] as const

export interface DesignFeatureDeps {
  /**
   * 画布标签的 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 由主进程拦截后交给设计服务。
   * 宿主不关心画布，具体接线由 app 注入。
   */
  setCanvasShortcutHandler?: (handler: ((action: 'undo' | 'redo') => void) | null) => void
}

function toolText(result: ToolResult): string {
  return result.content
    .map((item) => (item.type === 'text' ? item.text : '[image]'))
    .join('\n')
}

function downloadsDir(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return process.cwd()
  }
}

export function createDesignFeature(deps: DesignFeatureDeps = {}): BuiltinFeature {
  return {
    manifest: {
      id: DESIGN_FEATURE_ID,
      name: mt('feature.design.name'),
      version: '1.0.0',
      recommended: true,
    description: mt('feature.design.description'),
      contributes: {
        toolbar: [
          {
            id: 'open',
            label: mt('feature.design.label'),
            icon: '✦',
            command: 'design.open-canvas'
          }
        ],
        tools: [...DESIGN_TOOL_NAMES],
        statusCard: true
      }
    },
    activate(ctx: FeatureContext) {
      let wiring: DesignWiring | null = null

      const updateStatus = (): void => {
        if (!wiring) return
        const state = wiring.service.state()
        const version = state.version
        ctx.setStatus({
          text: state.dirty
            ? mt('feature.design.statusDirty', { version })
            : mt('feature.design.statusClean', { version }),
          detail: state.projectId
            ? mt('feature.design.project', { id: state.projectId })
            : undefined,
          tone: state.dirty ? 'warn' : 'ok',
          actions: [
            { id: 'open', label: mt('feature.design.actionOpen'), command: 'design.open-canvas' },
            { id: 'undo', label: mt('feature.design.actionUndo'), command: 'design.undo' },
            { id: 'commit', label: mt('feature.design.actionCommit'), command: 'design.commit' },
            { id: 'export', label: mt('feature.design.actionExport'), command: 'design.export' }
          ]
        })
      }

      /** 打开画布；同时把快捷键处理器指向当前 wiring（窗口重建后也会重新绑定）。 */
      const openCanvas = (): Electron.WebContents | null => {
        deps.setCanvasShortcutHandler?.((action) => wiring?.shortcut(action))
        return ctx.openCanvasTab()
      }

      const onServiceEvent = (event: DesignServiceEvent): void => {
        if (event.type === 'document' || event.type === 'state' || event.type === 'rejected') {
          updateStatus()
        }
      }

      wiring = createDesignWiring({
        win: ctx.win,
        log: ctx.log,
        caller: ctx.caller,
        openCanvas,
        assets: ctx.assets,
        onEvent: onServiceEvent
      })
      updateStatus()

      const serviceError = (): ToolResult => ({
        isError: true,
        content: [{ type: 'text', text: mt('feature.design.unavailable') }]
      })

      const registerTool = (name: string): void => {
        ctx.registerToolHandler(name, async (args) => {
          if (!wiring) return serviceError()
          return wiring.runTool(name, args)
        })
      }
      for (const name of DESIGN_TOOL_NAMES) registerTool(name)

      ctx.registerCommand('design.open-canvas', () => {
        const contents = openCanvas()
        if (!contents) return { ok: false, error: mt('feature.design.canvasMissing') }
        return { ok: true }
      })

      ctx.registerCommand('design.state', () => {
        if (!wiring) return { ok: false, error: mt('feature.design.unavailable') }
        return { ok: true, state: wiring.service.state(), name: wiring.service.current().name }
      })

      ctx.registerCommand('design.undo', () => {
        if (!wiring) return { ok: false, error: mt('feature.design.unavailable') }
        const changed = wiring.service.undo()
        updateStatus()
        return { ok: true, changed }
      })

      ctx.registerCommand('design.redo', () => {
        if (!wiring) return { ok: false, error: mt('feature.design.unavailable') }
        const changed = wiring.service.redo()
        updateStatus()
        return { ok: true, changed }
      })

      ctx.registerCommand('design.commit', (args) => {
        if (!wiring) return { ok: false, error: mt('feature.design.unavailable') }
        const summary =
          typeof args['summary'] === 'string' && args['summary'].trim()
            ? args['summary'].trim()
            : mt('feature.design.round')
        const outcome = wiring.service.commitRound(summary)
        updateStatus()
        if (!outcome.ok) return { ok: false, error: outcome.error ?? mt('feature.design.commitFailed') }
        return { ok: true, sha: outcome.sha, skipped: outcome.skipped === true, summary }
      })

      ctx.registerCommand('design.export', async () => {
        if (!wiring) return { ok: false, error: mt('feature.design.unavailable') }
        const state = wiring.service.state()
        const defaultName = `${state.projectId ?? 'design'}-design.zip`
        try {
          const win = ctx.win()
          const options = {
            title: mt('feature.design.exportTitle'),
            defaultPath: path.join(downloadsDir(), defaultName),
            filters: [{ name: 'ZIP', extensions: ['zip'] }]
          }
          const picked = win
            ? await dialog.showSaveDialog(win, options)
            : await dialog.showSaveDialog(options)
          if (picked.canceled || !picked.filePath) {
            return { ok: false, canceled: true, error: mt('feature.design.exportCanceled') }
          }
          const target = /\.zip$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.zip`
          const outcome = wiring.service.exportZip(target, ctx.assets)
          if (!outcome.ok) {
            return { ok: false, error: outcome.error ?? mt('feature.design.exportFailed') }
          }
          return { ok: true, path: outcome.path ?? target }
        } catch (error) {
          return { ok: false, error: (error as Error).message }
        }
      })

      ctx.registerCommand('design.insert-image', (args) => {
        if (!wiring) return { ok: false, error: mt('feature.design.unavailable') }
        const assetId = typeof args['assetId'] === 'string' ? args['assetId'].trim() : ''
        if (!assetId) return { ok: false, error: mt('feature.design.imageMissingId') }
        const entry = ctx.assets?.get?.(assetId)
        if (!entry) return { ok: false, error: mt('feature.design.imageMissing') }
        const nodeId = `image-${Date.now().toString(36)}`
        const ops: PatchOp[] = [
          {
            op: 'insert',
            parentId: wiring.service.current().root.id,
            node: {
              id: nodeId,
              type: 'image',
              text: entry.name,
              style: { assetId, minHeight: '220px', width: '100%' }
            }
          }
        ]
        const result = wiring.service.applyOps('user', ops, { allowLocked: true })
        if (result.applied === 0) {
          return {
            ok: false,
            error: result.rejected.map((item) => item.reason).join('；') || mt('feature.design.insertFailed')
          }
        }
        return { ok: true, id: nodeId }
      })

      return {
        deactivate: () => {
          deps.setCanvasShortcutHandler?.(null)
          wiring?.dispose()
          wiring = null
        }
      }
    }
  }
}
