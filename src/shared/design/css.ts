/**
 * 画布 DOM 与静态导出共用的 CSS / 标签安全网。
 *
 * 这里不仅供 style.setProperty 使用，也供文本形式生成 styles.css 使用，
 * 因此属性名必须是完整 CSS 标识，值不能结束当前声明或插入注释/规则。
 */
import type { DesignNode } from './model'

const UNSAFE_PROPERTIES: ReadonlySet<string> = new Set([
  'behavior',
  '-moz-binding',
  'content',
  'background-image'
])

const UNSAFE_VALUE = /url\s*\(|(?:-webkit-)?image-set\s*\(|expression\s*\(|javascript\s*:|@import|-moz-binding|behavior\s*:/i
const CSS_PROPERTY = /^(?:--[a-z0-9_-]+|-?[a-z][a-z0-9-]*)$/i
const CSS_DECLARATION_BREAK = /[;{}\u0000-\u001f\u007f]|\/\*|\*\//

export function isSafeStyleProperty(property: string): boolean {
  const name = property.trim().toLowerCase()
  if (!CSS_PROPERTY.test(name)) return false
  if (name.startsWith('on')) return false
  return !UNSAFE_PROPERTIES.has(name)
}

export function isSafeStyleValue(value: string): boolean {
  if (!value || CSS_DECLARATION_BREAK.test(value)) return false
  // 反斜杠可以把 url / javascript 等关键字拆开写成 CSS 转义，安全网不做猜测性解码。
  if (value.includes('\\')) return false
  return !UNSAFE_VALUE.test(value)
}

/** `flexDirection` / `flex-direction` / `--custom-prop` 统一成 CSS 属性名。 */
export function toCssPropertyName(key: string): string {
  const name = key.trim()
  if (!name) return ''
  if (name.startsWith('--')) return name
  if (name.includes('-')) return name.toLowerCase()
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** 允许出现在画布和导出 HTML 里的标签；加载资源或导航的标签不在其中。 */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'div',
  'span',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'main',
  'aside',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'figure',
  'figcaption',
  'blockquote',
  'strong',
  'em',
  'small',
  'hr',
  'dl',
  'dt',
  'dd',
  'pre',
  'code',
  'button',
  'input',
  'label',
  // 图片：src 只由渲染/导出按资产 id 显式写入，不来自 style 字符串
  'img'
])

const DEFAULT_TAG: Record<DesignNode['type'], string> = {
  page: 'div',
  box: 'div',
  stack: 'div',
  grid: 'div',
  text: 'p',
  heading: 'h2',
  button: 'button',
  input: 'input',
  image: 'img',
  spacer: 'div'
}

/** 节点 → 实际标签。自定义 tag 必须过白名单。 */
export function elementTagFor(node: DesignNode): string {
  const custom = typeof node.tag === 'string' ? node.tag.trim().toLowerCase() : ''
  if (custom && ALLOWED_TAGS.has(custom)) return custom
  return DEFAULT_TAG[node.type] ?? 'div'
}
