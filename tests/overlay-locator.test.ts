import { describe, expect, it } from 'vitest'
import { anchorPoint } from '../src/shared/design/model'
import {
  ANCHOR_NAMES,
  anchorCandidates,
  anchorFromCandidate,
  edgeSnapCandidates,
  formatMeasureDelta,
  formatMeasurePrimary,
  gridSnapCandidate,
  measureBetween,
  nearestAnchor,
  resolveSnap,
  roundToGrid
} from '../src/overlay-preload/design-utils'
import type { Rect, SnapRect } from '../src/overlay-preload/design-utils'

const viewport = { width: 1200, height: 800 }
const rect: Rect = { x: 100, y: 50, width: 200, height: 80 }
const rects: SnapRect[] = [{ id: 'card-1', rect }]

describe('九点锚点', () => {
  it('恰好 9 个且不重复，与 model.anchorPoint 一致', () => {
    expect(ANCHOR_NAMES).toHaveLength(9)
    expect(new Set(ANCHOR_NAMES).size).toBe(9)
    const candidates = anchorCandidates(rect, 'card-1')
    expect(candidates).toHaveLength(9)
    candidates.forEach((candidate, index) => {
      const anchor = ANCHOR_NAMES[index]
      expect(anchor).toBeDefined()
      if (!anchor) return
      expect(candidate.point).toEqual(anchorPoint(rect, anchor))
      expect(candidate.from).toBe(`card-1@${anchor}`)
      expect(anchorFromCandidate(candidate.from)).toBe(anchor)
    })
    expect(anchorFromCandidate('grid')).toBeNull()
    expect(anchorFromCandidate('viewport-left')).toBeNull()
    expect(anchorFromCandidate('card-1@nope')).toBeNull()
  })

  it('nearestAnchor 找到最近的角 / 中心', () => {
    expect(nearestAnchor(rect, { x: 299, y: 129 }).anchor).toBe('bottom-right')
    expect(nearestAnchor(rect, { x: 200, y: 90 })).toEqual({
      anchor: 'center',
      point: { x: 200, y: 90 },
      distance: 0
    })
  })

  it('网格候选把点吸到最近 8px 交点', () => {
    expect(roundToGrid(3)).toBe(0)
    expect(roundToGrid(13)).toBe(16)
    expect(roundToGrid(500)).toBe(504)
    expect(gridSnapCandidate({ x: 3, y: 13 }).point).toEqual({ x: 0, y: 16 })
  })

  it('视口边缘候选只在阈值内产生', () => {
    expect(edgeSnapCandidates({ x: 3, y: 400 }, viewport, 8).map((c) => c.from)).toEqual([
      'viewport-left'
    ])
    expect(edgeSnapCandidates({ x: 1199, y: 400 }, viewport, 8).map((c) => c.from)).toEqual([
      'viewport-right'
    ])
    expect(edgeSnapCandidates({ x: 600, y: 400 }, viewport, 8)).toEqual([])
  })
})

describe('分层吸附：元素锚点 → 视口边缘 → 8px 网格', () => {
  it('命中元素锚点时返回锚点名与参考线', () => {
    const decision = resolveSnap({ x: 103, y: 53 }, rects, { viewport })
    expect(decision.snapped?.from).toBe('card-1@top-left')
    expect(decision.point).toEqual({ x: 100, y: 50 })
    expect(decision.anchor).toBe('top-left')
    expect(decision.guides).toEqual({ x: 100, y: 50 })
  })

  it('网格离得更近时仍然优先元素锚点（分层而非比距离）', () => {
    // 锚点距离 4.24px，网格点 (104,56) 距离 3.16px —— 元素优先。
    const decision = resolveSnap({ x: 103, y: 53 }, rects, { viewport })
    expect(decision.snapped?.from).toBe('card-1@top-left')
    expect(decision.point).toEqual({ x: 100, y: 50 })
  })

  it('元素中心锚点命中（点在元素内部）', () => {
    const decision = resolveSnap({ x: 200, y: 90 }, rects, { viewport })
    expect(decision.anchor).toBe('center')
    expect(decision.point).toEqual({ x: 200, y: 90 })
  })

  it('远离锚点和页边时兜底到 8px 网格', () => {
    const decision = resolveSnap({ x: 500, y: 500 }, [], { viewport })
    expect(decision.snapped?.from).toBe('grid')
    expect(decision.point).toEqual({ x: 504, y: 504 })
    expect(decision.anchor).toBeNull()
    expect(decision.guides).toEqual({ x: 504, y: 504 })
  })

  it('关闭网格且没有锚点/页边时保持原点、不画参考线', () => {
    const desired = { x: 500, y: 500 }
    const decision = resolveSnap(desired, [], { viewport, grid: false })
    expect(decision.snapped).toBeNull()
    expect(decision.point).toEqual(desired)
    expect(decision.guides).toEqual({ x: null, y: null })
  })

  it('页边吸附优先于网格', () => {
    const decision = resolveSnap({ x: 3, y: 400 }, [], { viewport })
    expect(decision.snapped?.from).toBe('viewport-left')
    expect(decision.point).toEqual({ x: 0, y: 400 })
    expect(decision.anchor).toBeNull()
  })

  it('阈值可配置：2px 时稍远一点就不吸', () => {
    const decision = resolveSnap({ x: 104, y: 54 }, rects, { viewport, threshold: 2, grid: false })
    expect(decision.snapped).toBeNull()
    expect(decision.point).toEqual({ x: 104, y: 54 })
  })
})

describe('测量尺：距离与水平/垂直分量', () => {
  it('正方向', () => {
    const measurement = measureBetween({ x: 10, y: 20 }, { x: 110, y: 70 })
    expect(measurement.dx).toBe(100)
    expect(measurement.dy).toBe(50)
    expect(measurement.horizontal).toBe(100)
    expect(measurement.vertical).toBe(50)
    expect(measurement.distance).toBeCloseTo(Math.hypot(100, 50), 6)
    expect(formatMeasurePrimary(measurement)).toBe('112px')
    expect(formatMeasureDelta(measurement)).toBe('水平 100px · 垂直 50px')
  })

  it('反方向分量取绝对值显示', () => {
    const measurement = measureBetween({ x: 100, y: 100 }, { x: 40, y: 80 })
    expect(measurement.dx).toBe(-60)
    expect(measurement.dy).toBe(-20)
    expect(formatMeasureDelta(measurement)).toBe('水平 60px · 垂直 20px')
  })

  it('同一位置距离为 0', () => {
    const measurement = measureBetween({ x: 5, y: 5 }, { x: 5, y: 5 })
    expect(measurement.distance).toBe(0)
    expect(formatMeasurePrimary(measurement)).toBe('0px')
  })
})
