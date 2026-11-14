/**
 * 设计画布的 preload。
 *
 * 画布页面是**我们自己的**本地页面（file:// 加载 out/canvas/index.html），
 * 所以这里可以给出比普通网页更明确的桥：只允许一组固定的消息类型，
 * 其余一切拒绝——避免把任意对象透传到主进程。
 */
import { contextBridge, ipcRenderer } from 'electron'

/** 画布可以发给主进程的消息（白名单）。 */
export type CanvasToHost =
  | {
      type: 'user-move'
      id: string
      anchor: string
      target: { x: number; y: number }
      frameWidth: number
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

const ALLOWED = new Set<CanvasToHost['type']>([
  'user-move',
  'user-locate',
  'user-update',
  'lock',
  'variant-choose',
  'viewport',
  'undo',
  'redo',
  'commit-round',
  'export',
  'select'
])

function sanitize(msg: unknown): CanvasToHost | null {
  if (!msg || typeof msg !== 'object') return null
  const type = (msg as { type?: unknown }).type
  if (typeof type !== 'string' || !ALLOWED.has(type as CanvasToHost['type'])) return null
  // 只做形状校验，不做业务校验（业务在主进程）
  try {
    JSON.stringify(msg)
  } catch {
    return null
  }
  return msg as CanvasToHost
}

contextBridge.exposeInMainWorld('canvasHost', {
  ready: (): void => {
    ipcRenderer.send('design:canvas-ready')
  },
  send: (msg: unknown): void => {
    const safe = sanitize(msg)
    if (!safe) {
      console.warn('[canvas] 拒绝发送未授权的消息类型')
      return
    }
    ipcRenderer.send('design:canvas-msg', safe)
  },
  on: (handler: (msg: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => handler(payload)
    ipcRenderer.on('design:canvas-event', listener)
    return () => ipcRenderer.removeListener('design:canvas-event', listener)
  }
})
