/** 极小的 DOM 辅助函数，避免各模块重复样板代码。 */

import type { Rect } from '../shared/design/model'

export interface ElOptions {
  className?: string
  text?: string
  attrs?: Record<string, string>
  dataset?: Record<string, string>
  children?: Array<Node | null | undefined>
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options.className) node.className = options.className
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) node.setAttribute(name, value)
  }
  if (options.dataset) {
    for (const [name, value] of Object.entries(options.dataset)) node.dataset[name] = value
  }
  if (options.text !== undefined) node.textContent = options.text
  for (const child of options.children ?? []) {
    if (child) node.append(child)
  }
  return node
}

/** 只在内容真的变了时才写 textContent（避免无意义的 DOM 变更）。 */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

export function setVisible(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible
}

/** 注册监听并返回取消函数（模块 destroy 时统一清理）。 */
export function on<E extends Event>(
  target: EventTarget,
  type: string,
  handler: (event: E) => void,
  options?: boolean | AddEventListenerOptions
): () => void {
  const listener = (event: Event): void => handler(event as E)
  target.addEventListener(type, listener, options)
  return () => target.removeEventListener(type, listener, options)
}

export function toRect(rect: DOMRect | Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}
