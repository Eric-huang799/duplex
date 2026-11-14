import { describe, expect, it } from 'vitest'
import {
  elementTargetId,
  formatPointReadout,
  formatSize,
  normalizeColor
} from '../src/overlay-preload/design-utils'

describe('放大镜读数：坐标与尺寸', () => {
  it('视口坐标四舍五入显示', () => {
    expect(formatPointReadout({ x: 120.6, y: 40.2 })).toBe('121, 40')
    expect(formatPointReadout({ x: 0.2, y: -3.2 })).toBe('0, -3')
    expect(formatPointReadout({ x: 1, y: 2 })).toBe('1, 2')
  })

  it('尺寸用 w×h 表示，取整', () => {
    expect(formatSize(200.4, 80.6)).toBe('200×81')
    expect(formatSize(0, 0)).toBe('0×0')
    expect(formatSize(1439.6, 899.5)).toBe('1440×900')
  })
})

describe('放大镜读数：元素身份 data-did → #id → 标签名', () => {
  it('优先 data-did（设计节点的稳定 id）', () => {
    expect(elementTargetId({ did: 'hero-1', id: 'app', tag: 'DIV' })).toBe('hero-1')
    expect(elementTargetId({ did: '  hero-1  ', tag: 'DIV' })).toBe('hero-1')
  })

  it('没有 data-did 时退回 #id，再退回小写标签名', () => {
    expect(elementTargetId({ id: 'app', tag: 'DIV' })).toBe('#app')
    expect(elementTargetId({ tag: 'BUTTON' })).toBe('button')
    expect(elementTargetId({ did: '   ', id: '  ', tag: '' })).toBe('element')
  })
})

describe('放大镜读数：颜色归一', () => {
  it('rgb 归一成 #rrggbb', () => {
    expect(normalizeColor('rgb(18, 24, 31)')).toBe('#12181f')
    expect(normalizeColor('rgb(255 255 255)')).toBe('#ffffff')
    expect(normalizeColor('rgb(50%, 0%, 0%)')).toBe('#800000')
  })

  it('半透明保留 rgba，完全透明显示 transparent', () => {
    expect(normalizeColor('rgba(18, 24, 31, 0.5)')).toBe('rgba(18, 24, 31, 0.5)')
    expect(normalizeColor('rgba(0, 0, 0, 0)')).toBe('transparent')
    expect(normalizeColor('transparent')).toBe('transparent')
  })

  it('非 rgb 值原样保留（含 hex），超长值截断', () => {
    expect(normalizeColor('#e8b84b')).toBe('#e8b84b')
    expect(normalizeColor('')).toBe('transparent')
    const long = 'linear-gradient(90deg, rgba(1, 2, 3, 0.5) 0%, #ffffff 100%)'
    const normalized = normalizeColor(long)
    expect(normalized.length).toBeLessThanOrEqual(40)
    expect(normalized.endsWith('…')).toBe(true)
  })
})
