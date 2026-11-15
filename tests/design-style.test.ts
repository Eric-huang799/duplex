import { describe, expect, it } from 'vitest'
import { emptyDocument } from '../src/shared/design/model'
import {
  resolveTokenExpression,
  resolveTokenValue,
  tokenVarMap,
  tokenVarName
} from '../src/shared/design/style'

const tokens = emptyDocument('t', 'd').tokens

describe('共享令牌解析', () => {
  it('整值是令牌时返回真实值（短名与全名都认）', () => {
    expect(resolveTokenValue(tokens, 'brand.primary')).toBe('#2f6fed')
    expect(resolveTokenValue(tokens, 'color.brand.primary')).toBe('#2f6fed')
  })

  it('组合值里的令牌也被替换（这是画布边框消失的原因）', () => {
    expect(resolveTokenValue(tokens, '1px solid line.soft')).toBe('1px solid #e5e7eb')
    expect(resolveTokenValue(tokens, '4px 8px')).toBe('4px 8px')
  })

  it('未知令牌原样保留，不吞掉用户写的值', () => {
    expect(resolveTokenValue(tokens, 'nope.nope')).toBe('nope.nope')
    expect(resolveTokenValue(tokens, '1px dashed nope.nope')).toBe('1px dashed nope.nope')
  })

  it('var 模式给的是可被覆盖的 CSS 变量（导出用）', () => {
    expect(resolveTokenExpression(tokens, 'brand.primary', 'var')).toBe('var(--color-brand-primary)')
    expect(resolveTokenExpression(tokens, '1px solid line.soft', 'var')).toBe(
      '1px solid var(--color-line-soft)'
    )
    expect(tokenVarName('space', '4')).toBe('--space-4')
    expect(tokenVarMap(tokens).get('text.muted')).toBe('var(--color-text-muted)')
  })
})
