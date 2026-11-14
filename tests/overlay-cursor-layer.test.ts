import { describe, expect, it } from 'vitest'
import {
  ACTOR_PALETTE,
  CURSOR_STATES,
  actorColor,
  actorLabel,
  easeInOutCubic,
  hashActor,
  isCursorState,
  isMotionDone,
  layoutLabels,
  makeMotion,
  motionPoint,
  parkOnEdge
} from '../src/overlay-preload/design-utils'

describe('actor 标识：稳定颜色 + 短标签', () => {
  it('同一 actor 颜色稳定，且一定落在 12 色调色板内', () => {
    expect(ACTOR_PALETTE).toHaveLength(12)
    expect(actorColor('agent-1')).toBe(actorColor('agent-1'))
    expect(ACTOR_PALETTE).toContain(actorColor('agent-1'))
    expect(ACTOR_PALETTE).toContain(actorColor('设计助手'))
  })

  it('不同 actor 一般落在不同色（哈希有区分度）', () => {
    expect(hashActor('agent-1')).not.toBe(hashActor('agent-2'))
    const colors = new Set(Array.from({ length: 24 }, (_, i) => actorColor(`agent-${i}`)))
    expect(colors.size).toBeGreaterThan(1)
  })

  it('标签最多 12 个字符，按码点截断（不会劈开 emoji）', () => {
    expect(actorLabel('agent-1')).toBe('agent-1')
    expect(actorLabel('abcdefghijklmnopqrst')).toBe('abcdefghijk…')
    expect(Array.from(actorLabel('abcdefghijklmnopqrst'))).toHaveLength(12)
    expect(actorLabel('🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖')).toBe('🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖…')
    expect(actorLabel('   ')).toBe('anon')
  })
})

describe('光标状态只认调用方给的那 7 个', () => {
  it('CURSOR_STATES 是唯一真源，idle 不是可下发状态', () => {
    for (const state of CURSOR_STATES) expect(isCursorState(state)).toBe(true)
    expect(CURSOR_STATES).toContain('blocked')
    expect(CURSOR_STATES).toContain('paused')
    expect(CURSOR_STATES).toContain('failed')
    expect(CURSOR_STATES).not.toContain('idle')
    expect(isCursorState('done')).toBe(false)
    expect(isCursorState('')).toBe(false)
    expect(isCursorState(42)).toBe(false)
    expect(isCursorState(null)).toBe(false)
  })
})

describe('移动轨迹：缓动、不瞬移、可中途改向', () => {
  const from = { x: 0, y: 0 }
  const to = { x: 100, y: 50 }
  const motion = makeMotion(from, to, 1000, 500)

  it('easeInOutCubic 端点正确、先慢后快、入参夹取', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6)
    expect(easeInOutCubic(0.25)).toBeLessThan(0.25)
    expect(easeInOutCubic(0.75)).toBeGreaterThan(0.75)
    expect(easeInOutCubic(-5)).toBe(0)
    expect(easeInOutCubic(5)).toBe(1)
  })

  it('中间帧在轨迹上而不是直接在终点（不是瞬移）', () => {
    expect(motionPoint(motion, 1000)).toEqual(from)
    expect(motionPoint(motion, 1500)).toEqual(to)
    const mid = motionPoint(motion, 1250)
    expect(mid.x).toBeGreaterThan(0)
    expect(mid.x).toBeLessThan(100)
    expect(mid.y).toBeGreaterThan(0)
    expect(mid.y).toBeLessThan(50)
    expect(isMotionDone(motion, 1250)).toBe(false)
    expect(isMotionDone(motion, 1500)).toBe(true)
    expect(motionPoint(motion, -100)).toEqual(from)
  })

  it('同一 actor 的新目标从当前渲染位置出发（中途改向）', () => {
    const current = motionPoint(motion, 1200)
    const retarget = makeMotion(current, { x: -200, y: 300 }, 1200, 300)
    expect(retarget.from).toEqual(current)
    const start = motionPoint(retarget, 1200)
    const later = motionPoint(retarget, 1300)
    expect(start.x).toBeCloseTo(current.x, 6)
    expect(later.x).toBeLessThan(start.x)
    expect(later.x).toBeGreaterThanOrEqual(-200)
  })

  it('duration 为 0 时无动画直接到终点', () => {
    const instant = makeMotion(from, to, 0, 0)
    expect(motionPoint(instant, 0)).toEqual(to)
    expect(isMotionDone(instant, 0)).toBe(true)
  })
})

describe('paused 状态收到页边', () => {
  it('按左右半屏选最近的边，并夹住 y', () => {
    expect(parkOnEdge({ x: 100, y: 400 }, { width: 1200, height: 800 })).toEqual({ x: 10, y: 400 })
    expect(parkOnEdge({ x: 1100, y: 900 }, { width: 1200, height: 800 })).toEqual({
      x: 1190,
      y: 790
    })
    expect(parkOnEdge({ x: 500, y: -50 }, { width: 1200, height: 800 })).toEqual({ x: 10, y: 10 })
  })
})

describe('多光标标签避让', () => {
  const viewport = { width: 1200, height: 800 }

  it('同一位置的两个标签上下错开，不互相遮挡', () => {
    const placements = layoutLabels(
      [
        { id: 'a', x: 100, y: 100, width: 80, height: 18 },
        { id: 'b', x: 100, y: 100, width: 80, height: 18 }
      ],
      { viewport }
    )
    expect(placements[0]).toEqual({ id: 'a', dx: 0, dy: 0 })
    expect(placements[1]?.dy ?? 0).toBeGreaterThanOrEqual(18)
  })

  it('相距很远的标签保持默认位置（不做无谓位移）', () => {
    const placements = layoutLabels(
      [
        { id: 'a', x: 20, y: 20, width: 90, height: 18 },
        { id: 'b', x: 800, y: 600, width: 90, height: 18 }
      ],
      { viewport }
    )
    expect(placements.every((placement) => placement.dx === 0 && placement.dy === 0)).toBe(true)
  })

  it('贴近右边缘时翻到指针左侧，且不超出视口', () => {
    const placements = layoutLabels([{ id: 'x', x: 1180, y: 200, width: 120, height: 18 }], {
      viewport
    })
    const placement = placements[0]
    expect(placement).toBeDefined()
    expect(placement?.dx ?? 0).toBeLessThan(0)
    expect(1180 + (placement?.dx ?? 0)).toBeGreaterThanOrEqual(6)
  })

  it('贴近底边时被夹回视口内', () => {
    const placements = layoutLabels([{ id: 'bottom', x: 300, y: 795, width: 90, height: 18 }], {
      viewport
    })
    const placement = placements[0]
    expect(placement).toBeDefined()
    expect(795 + (placement?.dy ?? 0) + 18).toBeLessThanOrEqual(800)
  })
})
