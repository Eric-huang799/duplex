/**
 * 设计令牌解析的**单一实现**：画布渲染器与静态导出共用这一份。
 *
 * 之前画布只做"整值恰好是令牌"的替换，所以 `border: '1px solid line.soft'`
 * 这种组合值原样输出，边框直接丢了；导出那边则自己写了一套。现在：
 *  - `resolveTokenValue` 返回**真实 CSS 值**（画布用）；
 *  - `resolveTokenExpression` 可以返回 `var(--…)`（导出用，保证令牌可覆盖）；
 *  - 两种情况都支持"组合值里出现的令牌名"和省略分组名的短名（`brand.primary`）。
 */
import type { DesignTokens, StyleTokenRef } from './model'

export const TOKEN_GROUPS = ['color', 'space', 'text', 'radius'] as const
export type TokenGroup = (typeof TOKEN_GROUPS)[number]

/** `(color, brand.primary)` → `--color-brand-primary`。 */
export function tokenVarName(group: string, key: string): string {
  return `--${group}-${key}`.replace(/[^A-Za-z0-9-]/g, '-').toLowerCase()
}

interface TokenEntry {
  group: TokenGroup
  key: string
  value: string
}

/** 展平令牌表；短名（省略分组）只有不冲突时才登记。 */
export function listTokens(tokens: DesignTokens): TokenEntry[] {
  const entries: TokenEntry[] = []
  for (const group of TOKEN_GROUPS) {
    for (const [key, value] of Object.entries(tokens[group])) {
      entries.push({ group, key, value })
    }
  }
  return entries
}

function lookupMaps(tokens: DesignTokens): {
  byName: Map<string, TokenEntry>
} {
  const byName = new Map<string, TokenEntry>()
  const entries = listTokens(tokens)
  // 全名优先
  for (const entry of entries) byName.set(`${entry.group}.${entry.key}`, entry)
  // 短名只在不冲突时登记（`space.4` 与 `radius.4` 都叫 `4` 时不猜）
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
  for (const entry of entries) {
    if ((counts.get(entry.key) ?? 0) === 1 && !byName.has(entry.key)) byName.set(entry.key, entry)
  }
  return { byName }
}

/** 令牌名 → CSS 变量，例如 `brand.primary` → `var(--color-brand-primary)`。 */
export function tokenVarMap(tokens: DesignTokens): Map<string, string> {
  const { byName } = lookupMaps(tokens)
  const map = new Map<string, string>()
  for (const [name, entry] of byName) map.set(name, `var(${tokenVarName(entry.group, entry.key)})`)
  return map
}

const TOKEN_IN_TEXT = /\b([a-z]+(?:\.[a-z0-9-]+)+)\b/gi

/**
 * 解析一个样式值。
 *
 * @param mode `value` = 真实值（画布）；`var` = CSS 变量引用（导出）。
 */
export function resolveTokenExpression(
  tokens: DesignTokens,
  value: StyleTokenRef | string,
  mode: 'value' | 'var' = 'value'
): string {
  const { byName } = lookupMaps(tokens)
  const substitute = (name: string): string | null => {
    const entry = byName.get(name)
    if (!entry) return null
    return mode === 'var' ? `var(${tokenVarName(entry.group, entry.key)})` : entry.value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return trimmed
    const whole = substitute(trimmed)
    if (whole !== null) return whole
    return trimmed.replace(TOKEN_IN_TEXT, (match) => substitute(match) ?? match)
  }
  if (value.token) {
    const fromToken = substitute(value.token)
    if (fromToken !== null) return fromToken
  }
  // 未知令牌：退回调用方给的字面值；没有就返回空串（交给上层决定丢弃）。
  return typeof value.value === 'string' ? value.value : ''
}

/** 画布用：拿到真实 CSS 值。 */
export function resolveTokenValue(tokens: DesignTokens, value: StyleTokenRef | string): string {
  return resolveTokenExpression(tokens, value, 'value')
}
