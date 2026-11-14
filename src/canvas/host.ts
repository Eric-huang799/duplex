/**
 * 与宿主（preload 注入的 `window.canvasHost`）的通信契约。
 *
 * 这是**唯一**定义消息形状的地方；主进程侧的 preload 需要与这里保持一致。
 * 类型全局命名空间刻意不用 `declare global`，避免和 preload 自己的 d.ts 打架。
 */

import type { DesignDocument, DesignNode, PatchOp, Rect } from '../shared/design/model'

export type OutboundMessage =
  | {
      type: 'user-move'
      id: string
      anchor: string
      target: { x: number; y: number }
      frameWidth: number
      /**
       * 该元素**当前**在设计帧坐标系下的包围盒（已换算掉画布缩放/滚动）。
       * 主进程可以直接 `moveDelta(rect, anchor, target)` 得到落点所需位移。
       */
      rect: Rect
    }
  | {
      type: 'user-locate'
      targetId: string
      anchor: string
      point: { x: number; y: number }
      frameWidth: number
    }
  | { type: 'user-update'; id: string; patch: Record<string, unknown> }
  | { type: 'lock'; id: string; locked: boolean }
  | { type: 'variant-choose'; blockId: string; index: number }
  | { type: 'viewport'; width: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'commit-round'; summary: string }
  | { type: 'export' }
  | { type: 'select'; id: string | null }

export type InboundMessage =
  | { type: 'document'; doc: DesignDocument }
  | { type: 'patch'; ops: PatchOp[]; doc: DesignDocument }
  | { type: 'variants'; blockId: string; options: DesignNode[] }
  | { type: 'state'; round: number; dirty: boolean; actor: string }
  | { type: 'cursor'; actor: string; x: number; y: number; state: string }

export interface CanvasHost {
  ready(): void
  send(message: OutboundMessage): void
  on(handler: (message: InboundMessage) => void): void
}

/**
 * 读取宿主。`window.canvasHost` 不存在（浏览器里直接打开）或注入不完整时返回 null，
 * 调用方走内置演示宿主，保证不依赖主进程也能独立开发/截图。
 */
export function readCanvasHost(): CanvasHost | null {
  const candidate = (window as unknown as { canvasHost?: unknown }).canvasHost
  if (!candidate || typeof candidate !== 'object') return null
  const host = candidate as Partial<CanvasHost>
  if (
    typeof host.ready !== 'function' ||
    typeof host.send !== 'function' ||
    typeof host.on !== 'function'
  ) {
    console.warn('[canvas] window.canvasHost 结构不完整，降级为演示模式', host)
    return null
  }
  return host as CanvasHost
}
