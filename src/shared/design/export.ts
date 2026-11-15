/**
 * 从设计文档生成**可交付**的静态站点（index.html + styles.css）。
 *
 * 这是"画布不是玩具"的关键一步：文档是真相，导出必须是真实的 HTML/CSS，
 * 而不是只把 design.json 打包。
 *
 * 约定：
 *  - 每个节点一个类 `.d-<id>`，并带 `data-did`，方便后续继续定位；
 *  - tokens 变成 CSS 变量（`--color-brand-primary` 等），样式里引用它们；
 *  - 帧内绝对定位（x/y）导出成**百分比**，因此导出的页面在不同宽度下仍保持在帧内的相对位置；
 *  - 文本做 HTML 转义，不输出任何脚本。
 */
import type { DesignDocument, DesignNode, StyleTokenRef } from './model'

const TAG_OF: Record<DesignNode['type'], string> = {
  page: 'main',
  box: 'div',
  stack: 'div',
  grid: 'div',
  text: 'p',
  heading: 'h2',
  button: 'button',
  input: 'input',
  image: 'div',
  spacer: 'div'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function cssVarName(group: string, key: string): string {
  return `--${group}-${key}`.replace(/[^A-Za-z0-9-]/g, '-').toLowerCase()
}

/** 文档里的令牌名 → CSS 变量（`brand.primary` → `var(--color-brand-primary)`）。 */
function tokenVarMap(doc: DesignDocument): Map<string, string> {
  const map = new Map<string, string>()
  for (const group of TOKEN_GROUPS) {
    for (const key of Object.keys(doc.tokens[group])) {
      const cssVar = `var(${cssVarName(group, key)})`
      map.set(`${group}.${key}`, cssVar)
      // 画布里的写法省略分组名（`brand.primary` 而不是 `color.brand.primary`），
      // 所以短名也要能解析；只有不冲突时才登记。
      if (!map.has(key)) map.set(key, cssVar)
    }
  }
  return map
}

/**
 * 样式值 → CSS 值。
 *
 * 画布里 `style` 的写法是"直接写令牌名"（例如 `background: 'brand.primary'`、
 * `border: '1px solid line.soft'`），所以导出时要把**整串**或**串里出现的令牌名**
 * 换成 CSS 变量，否则导出页面会带着 `brand.primary` 这种非法值。
 */
function resolveValue(doc: DesignDocument, value: StyleTokenRef | string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    if (!value.token) return value.value
    const [group, ...rest] = value.token.split('.')
    const vars = tokenVarMap(doc)
    const resolved = vars.get(value.token)
    if (resolved) return resolved
    return rest.length > 0 ? value.value : `var(${cssVarName(group, rest.join('-'))})`
  }
  const vars = tokenVarMap(doc)
  const trimmed = value.trim()
  const direct = vars.get(trimmed)
  if (direct) return direct
  return value.replace(/\b([a-z]+(?:\.[a-z0-9-]+)+)\b/gi, (match) => vars.get(match) ?? match)
}

function nodeClass(node: DesignNode): string {
  return `d-${node.id.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

function renderNode(doc: DesignDocument, node: DesignNode, depth: number): string {
  const pad = '  '.repeat(depth)
  const tag = TAG_OF[node.type] ?? 'div'
  const classes = ['d-node', nodeClass(node)].join(' ')
  const attrs = [`class="${classes}"`, `data-did="${escapeHtml(node.id)}"`]
  if (node.type === 'button') attrs.push('type="button"')
  if (node.type === 'input') {
    attrs.push('placeholder="' + escapeHtml(node.text ?? '') + '"')
    return `${pad}<input ${attrs.join(' ')} />`
  }
  const text = node.text ? escapeHtml(node.text) : ''
  if ((node.children?.length ?? 0) === 0) {
    return `${pad}<${tag} ${attrs.join(' ')}>${text}</${tag}>`
  }
  const inner = node.children!.map((child) => renderNode(doc, child, depth + 1)).join('\n')
  return `${pad}<${tag} ${attrs.join(' ')}>\n${text ? `${pad}  ${text}\n` : ''}${inner}\n${pad}</${tag}>`
}

const TOKEN_GROUPS = ['color', 'space', 'text', 'radius'] as const

function renderTokens(doc: DesignDocument): string {
  const lines: string[] = []
  for (const group of TOKEN_GROUPS) {
    for (const [key, value] of Object.entries(doc.tokens[group])) {
      lines.push(`  ${cssVarName(group, key)}: ${value};`)
    }
  }
  return lines.join('\n')
}

/** 节点样式 → CSS 规则体（跳过 x/y/w/h，它们按百分比单独输出）。 */
function renderRules(doc: DesignDocument, node: DesignNode): string[] {
  const rules: string[] = []
  const style = node.style ?? {}
  const isAbsolute = style['x'] !== undefined || style['y'] !== undefined
  if (isAbsolute) {
    rules.push('  position: absolute;')
    const x = Number(resolveValue(doc, style['x']))
    const y = Number(resolveValue(doc, style['y']))
    if (Number.isFinite(x)) rules.push(`  left: ${((x / doc.frame.width) * 100).toFixed(3)}%;`)
    if (Number.isFinite(y)) rules.push(`  top: ${((y / doc.frame.height) * 100).toFixed(3)}%;`)
  }
  if (node.type === 'stack') rules.push('  display: flex;', '  flex-direction: column;')
  if (node.type === 'grid') rules.push('  display: grid;')
  for (const [key, raw] of Object.entries(style)) {
    if (key === 'x' || key === 'y') continue
    if (key === 'w') {
      const w = Number(resolveValue(doc, raw))
      if (Number.isFinite(w)) rules.push(`  width: ${((w / doc.frame.width) * 100).toFixed(3)}%;`)
      continue
    }
    if (key === 'h') {
      const h = Number(resolveValue(doc, raw))
      if (Number.isFinite(h)) rules.push(`  height: ${((h / doc.frame.height) * 100).toFixed(3)}%;`)
      continue
    }
    const value = resolveValue(doc, raw)
    if (value === undefined) continue
    // style 的键直接是 CSS 属性名（renderer 就是这样用的），转成 kebab-case
    const cssKey = key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
    rules.push(`  ${cssKey}: ${value};`)
  }
  return rules
}

export interface StaticSite {
  html: string
  css: string
}

export function renderStaticSite(doc: DesignDocument): StaticSite {
  const body = renderNode(doc, doc.root, 2)
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(doc.name)}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="frame">
${body}
  </div>
</body>
</html>
`
  const rules: string[] = []
  for (const node of flatten(doc.root)) {
    const body = renderRules(doc, node)
    if (body.length > 0) rules.push(`.${nodeClass(node)} {\n${body.join('\n')}\n}`)
  }
  const css = `/* 由 Duplex 设计画布生成（${doc.id} v${doc.version}） */
:root {
${renderTokens(doc)}
  --frame-width: ${doc.frame.width}px;
  --frame-height: ${doc.frame.height}px;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--color-text-primary, #111827);
  background: var(--color-surface-base, #ffffff);
}

.frame {
  position: relative;
  width: 100%;
  max-width: var(--frame-width);
  margin: 0 auto;
  min-height: 100vh;
}

.d-node { min-width: 0; }

${rules.join('\n\n')}
`
  return { html, css }
}

function flatten(root: DesignNode): DesignNode[] {
  const out: DesignNode[] = [root]
  for (const child of root.children ?? []) out.push(...flatten(child))
  return out
}
