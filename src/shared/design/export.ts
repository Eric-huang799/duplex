/**
 * 从设计文档生成**可交付**的静态站点（index.html + styles.css）。
 *
 * 这是"画布不是玩具"的关键一步：文档是真相，导出必须是真实的 HTML/CSS，
 * 而不是只把 design.json 打包。
 *
 * 约定：
 *  - 每个节点一个由 id 无损编码的类名，并带 `data-did`，方便后续继续定位；
 *  - tokens 变成 CSS 变量（`--color-brand-primary` 等），样式里引用它们；
 *  - 帧内绝对定位（x/y）导出成**百分比**，因此导出的页面在不同宽度下仍保持在帧内的相对位置；
 *  - 文本做 HTML 转义，不输出任何脚本。
 */
import type { DesignDocument, DesignNode, StyleTokenRef } from './model'
import { resolveTokenExpression, tokenVarName } from './style'
import { elementTagFor, isSafeStyleProperty, isSafeStyleValue, toCssPropertyName } from './css'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 样式值 → CSS 值：与画布共用一份令牌解析（shared/design/style.ts），导出用 var 模式。 */
function resolveValue(doc: DesignDocument, value: StyleTokenRef | string | undefined): string | undefined {
  if (value === undefined) return undefined
  const resolved = resolveTokenExpression(doc.tokens, value, 'var')
  return resolved === '' ? undefined : resolved
}

function nodeClass(node: DesignNode): string {
  // 全量编码而不是把标点替换成 '-'：a.b 与 a:b 必须得到不同类名。
  const bytes = new TextEncoder().encode(node.id)
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `d-${hex || 'empty'}`
}

type AssetHref = (assetId: string) => string | null

function renderNode(
  doc: DesignDocument,
  node: DesignNode,
  depth: number,
  assetHref?: AssetHref
): string {
  const pad = '  '.repeat(depth)
  const tag = elementTagFor(node)
  const classes = ['d-node', nodeClass(node)].join(' ')
  const attrs = [`class="${classes}"`, `data-did="${escapeHtml(node.id)}"`]
  if (tag === 'button') attrs.push('type="button"')
  if (tag === 'input') {
    attrs.push('value="' + escapeHtml(node.text ?? '') + '"', 'readonly')
    return `${pad}<input ${attrs.join(' ')} />`
  }
  if (tag === 'img') {
    const assetId = typeof node.style?.['assetId'] === 'string' ? node.style['assetId'].trim() : ''
    const href = assetId && assetHref ? assetHref(assetId) : null
    if (href) attrs.push(`src="${escapeHtml(href)}"`)
    attrs.push(`alt="${escapeHtml(node.text ?? '')}"`, 'loading="lazy"')
    return `${pad}<img ${attrs.join(' ')} />`
  }
  const text = node.text ? escapeHtml(node.text) : ''
  if ((node.children?.length ?? 0) === 0) {
    return `${pad}<${tag} ${attrs.join(' ')}>${text}</${tag}>`
  }
  const inner = node
    .children!.map((child) => renderNode(doc, child, depth + 1, assetHref))
    .join('\n')
  return `${pad}<${tag} ${attrs.join(' ')}>\n${text ? `${pad}  ${text}\n` : ''}${inner}\n${pad}</${tag}>`
}

const TOKEN_GROUPS = ['color', 'space', 'text', 'radius'] as const

function renderTokens(doc: DesignDocument): string {
  const lines: string[] = []
  for (const group of TOKEN_GROUPS) {
    for (const [key, value] of Object.entries(doc.tokens[group])) {
      if (!isSafeStyleValue(value)) continue
      lines.push(`  ${tokenVarName(group, key)}: ${value};`)
    }
  }
  return lines.join('\n')
}

/** 节点样式 → CSS 规则体（跳过 x/y/w/h，它们按百分比单独输出）。 */
function renderRules(doc: DesignDocument, node: DesignNode): string[] {
  const rules: string[] = []
  const style = node.style ?? {}
  const x = Number(resolveValue(doc, style['x']))
  const y = Number(resolveValue(doc, style['y']))
  if ((style['x'] !== undefined && Number.isFinite(x)) || (style['y'] !== undefined && Number.isFinite(y))) {
    rules.push('  position: absolute;')
    if (Number.isFinite(x)) rules.push(`  left: ${((x / doc.frame.width) * 100).toFixed(3)}%;`)
    if (Number.isFinite(y)) rules.push(`  top: ${((y / doc.frame.height) * 100).toFixed(3)}%;`)
  }
  if (node.type === 'stack') rules.push('  display: flex;', '  flex-direction: column;')
  if (node.type === 'grid') rules.push('  display: grid;')
  if (node.type === 'image') {
    rules.push('  display: block;', '  width: 100%;', '  height: auto;', '  object-fit: cover;')
  }
  for (const [key, raw] of Object.entries(style)) {
    // assetId 是资产引用，不是 CSS 属性
    if (key === 'x' || key === 'y' || key === 'assetId') continue
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
    const cssKey = toCssPropertyName(key)
    if (value === undefined || !isSafeStyleProperty(cssKey) || !isSafeStyleValue(value)) continue
    rules.push(`  ${cssKey}: ${value};`)
  }
  return rules
}

export interface StaticSite {
  html: string
  css: string
}

export function renderStaticSite(
  doc: DesignDocument,
  options: { assetHref?: AssetHref } = {}
): StaticSite {
  const body = renderNode(doc, doc.root, 2, options.assetHref)
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
