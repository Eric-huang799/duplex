import { describe, expect, it } from 'vitest'
import {
  activeBreakpoint,
  ancestorIds,
  anchorCandidatesOf,
  anchorsOf,
  clampViewportWidth,
  containerEdgeCandidates,
  cycleZoom,
  dragTarget,
  effectiveScale,
  elementTagFor,
  fitGeometry,
  fitScale,
  flashTargets,
  entranceTargets,
  formatPercent,
  gridCandidatesNear,
  layoutRectToScreen,
  layoutToScreen,
  measureBetween,
  movedRect,
  nearestAnchor,
  nudgeNumber,
  parseFrameLength,
  resolveStyleValue,
  resolveToken,
  screenRectToLayout,
  screenToLayout,
  snapThresholdForScale,
  snapToTiers,
  summarizeOps,
  toCssPropertyName,
  isSafeStyleProperty,
  isSafeStyleValue,
  type SnapTierInput
} from '../src/canvas/geometry'
import {
  anchorPoint,
  emptyDocument,
  type DesignNode,
  type PatchOp,
  type Rect
} from '../src/shared/design/model'

const tokens = emptyDocument('t', 't').tokens

describe('坐标换算（拖拽/定位的落点基础）', () => {
  it('screenToLayout / layoutToScreen 在 0.5 缩放下互为逆运算', () => {
    const origin = { x: 120, y: 40 }
    const client = { x: 320, y: 240 }
    const layout = screenToLayout(client, origin, 0.5)
    expect(layout).toEqual({ x: 400, y: 400 })
    expect(layoutToScreen(layout, origin, 0.5)).toEqual(client)
  })

  it('screenRectToLayout 同时换算位置与尺寸（检视器的只读值）', () => {
    const rect = { x: 220, y: 90, width: 300, height: 150 }
    const layout = screenRectToLayout(rect, { x: 120, y: 40 }, 0.5)
    expect(layout).toEqual({ x: 200, y: 100, width: 600, height: 300 })
  })

  it('layoutRectToScreen 是 screenRectToLayout 的逆运算', () => {
    const layout = { x: 24, y: 48, width: 300, height: 120 }
    const origin = { x: 10, y: 20 }
    const screen = layoutRectToScreen(layout, origin, 0.25)
    expect(screen).toEqual({ x: 16, y: 32, width: 75, height: 30 })
    expect(screenRectToLayout(screen, origin, 0.25)).toEqual(layout)
  })

  it('缩放按比例保护，scale<=0 时退化为 1 而不是 Infinity', () => {
    const point = screenToLayout({ x: 10, y: 10 }, { x: 0, y: 0 }, 0)
    expect(point).toEqual({ x: 10, y: 10 })
    expect(screenRectToLayout({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0 }, 0).width).toBe(10)
  })
})

describe('缩放与断点（响应式预览）', () => {
  it('fitScale 不放大超过 1，并在可用宽度不足时按比例缩小', () => {
    expect(fitScale(390, 1200)).toBe(1)
    expect(fitScale(1440, 800, 0)).toBeCloseTo(800 / 1440, 5)
    expect(fitScale(1920, 300, 0)).toBeCloseTo(300 / 1920, 5)
    expect(fitScale(0, 800)).toBe(1)
  })

  it('effectiveScale = 适配缩放 × 用户缩放，并夹在安全范围内', () => {
    const fit = fitScale(1440, 1000, 0)
    expect(fit).toBeCloseTo(1000 / 1440, 5)
    expect(effectiveScale(1440, 1000, 0.5, 0)).toBeCloseTo(fit * 0.5, 5)
    expect(effectiveScale(1440, 1000, 100, 0)).toBeLessThanOrEqual(4)
  })

  it('fitGeometry 给出缩放后的页面宽度（滚动容器占位的依据）', () => {
    const geometry = fitGeometry(390, 1200, 0.5)
    expect(geometry.fit).toBe(1)
    expect(geometry.scale).toBe(0.5)
    expect(geometry.scaledWidth).toBe(195)
  })

  it('Z 键按 1 → 0.5 → 0.25 → 1 循环，未知值回到 1', () => {
    expect(cycleZoom(1)).toBe(0.5)
    expect(cycleZoom(0.5)).toBe(0.25)
    expect(cycleZoom(0.25)).toBe(1)
    expect(cycleZoom(0.7)).toBe(1)
  })

  it('宽度被夹在 320~1920，且能识别命中的断点', () => {
    expect(clampViewportWidth(100)).toBe(320)
    expect(clampViewportWidth(9999)).toBe(1920)
    expect(clampViewportWidth(834.4)).toBe(834)
    expect(activeBreakpoint(1440)).toBe('desktop')
    expect(activeBreakpoint(390)).toBe('phone')
    expect(activeBreakpoint(1000)).toBeNull()
  })

  it('吸附阈值随缩放换算成 layout 距离（屏幕 8px 恒定）', () => {
    expect(snapThresholdForScale(1)).toBe(8)
    expect(snapThresholdForScale(0.5)).toBe(16)
    expect(snapThresholdForScale(0.25)).toBe(32)
    expect(snapThresholdForScale(0)).toBe(8)
  })
})

describe('拖拽位移 → 锚点对齐', () => {
  const rect: Rect = { x: 100, y: 50, width: 200, height: 80 }

  it('movedRect 把 center 锚点精确放到落点（拖拽松手的目标）', () => {
    const target = { x: 640, y: 360 }
    const moved = movedRect(rect, 'center', target)
    expect(anchorPoint(moved, 'center')).toEqual(target)
    expect(moved.x).toBe(540)
    expect(moved.y).toBe(320)
    expect(moved.width).toBe(200)
  })

  it('movedRect 对 top-left 锚点等价于直接平移左上角', () => {
    const moved = movedRect(rect, 'top-left', { x: 10, y: 20 })
    expect(moved).toEqual({ x: 10, y: 20, width: 200, height: 80 })
  })

  it('dragTarget 不做额外加工：落点就是幽灵框中心', () => {
    expect(dragTarget(rect, { x: 5, y: 6 })).toEqual({ x: 5, y: 6 })
  })

  it('nine 锚点每个都能在 movedRect 后落回目标点', () => {
    for (const anchor of ['top-left', 'top', 'right', 'center', 'bottom-right'] as const) {
      const target = { x: 123, y: 456 }
      const moved = movedRect(rect, anchor, target)
      expect(anchorPoint(moved, anchor)).toEqual(target)
    }
  })
})

describe('吸附候选与优先级', () => {
  const rect: Rect = { x: 100, y: 100, width: 200, height: 100 }

  it('anchorsOf 生成九个候选，来源带 id 与锚点名', () => {
    const candidates = anchorsOf(rect, 'card-1')
    expect(candidates).toHaveLength(9)
    const center = candidates.find((candidate) => candidate.from === 'card-1:center')
    expect(center?.point).toEqual({ x: 200, y: 150 })
    expect(candidates.map((candidate) => candidate.from)).toContain('card-1:bottom-right')
  })

  it('anchorCandidatesOf 汇总多个元素，且不包含被拖动元素自身（调用方过滤）', () => {
    const candidates = anchorCandidatesOf([
      { id: 'a', rect: { x: 0, y: 0, width: 10, height: 10 } },
      { id: 'b', rect: { x: 20, y: 20, width: 10, height: 10 } }
    ])
    expect(candidates).toHaveLength(18)
    expect(new Set(candidates.map((candidate) => candidate.from.split(':')[0]))).toEqual(
      new Set(['a', 'b'])
    )
  })

  it('网格候选只覆盖目标点附近，且都是 8 的倍数', () => {
    const desired = { x: 101, y: 203 }
    const candidates = gridCandidatesNear(desired)
    expect(candidates).toHaveLength(9)
    expect(candidates.every((candidate) => candidate.from === 'grid')).toBe(true)
    expect(candidates.every((candidate) => candidate.point.x % 8 === 0)).toBe(true)
    expect(candidates.every((candidate) => candidate.point.y % 8 === 0)).toBe(true)
    // 附近包含 96/104 这些相邻格点
    expect(new Set(candidates.map((candidate) => candidate.point.x))).toEqual(new Set([96, 104, 112]))
  })

  it('容器边缘候选：把点投影到四边（水平边保持 x，竖直边保持 y）', () => {
    const desired = { x: 130, y: 170 }
    const candidates = containerEdgeCandidates([{ id: 'page', rect }], desired)
    expect(candidates).toHaveLength(8)
    expect(candidates.find((candidate) => candidate.from === 'page:left')?.point).toEqual({
      x: 100,
      y: 170
    })
    expect(candidates.find((candidate) => candidate.from === 'page:bottom')?.point).toEqual({
      x: 130,
      y: 200
    })
    expect(candidates.find((candidate) => candidate.from === 'page:top-left')?.point).toEqual({
      x: 100,
      y: 100
    })
  })

  it('优先级：元素锚点 > 容器边缘 > 网格（即使网格更近）', () => {
    const desired = { x: 100, y: 100 }
    const tiers: SnapTierInput[] = [
      { tier: 'anchor', candidates: [{ point: { x: 106, y: 100 }, from: 'card:right' }] },
      { tier: 'edge', candidates: [{ point: { x: 100, y: 101 }, from: 'page:top' }] },
      { tier: 'grid', candidates: [{ point: { x: 100, y: 100 }, from: 'grid' }] }
    ]
    const result = snapToTiers(desired, tiers, 8)
    expect(result.tier).toBe('anchor')
    expect(result.from).toBe('card:right')
    expect(result.point).toEqual({ x: 106, y: 100 })
  })

  it('高优先级档没有命中时逐档回退，最后回到网格', () => {
    const desired = { x: 100, y: 100 }
    const tiers: SnapTierInput[] = [
      { tier: 'anchor', candidates: [{ point: { x: 200, y: 200 }, from: 'far:center' }] },
      { tier: 'edge', candidates: [{ point: { x: 104, y: 100 }, from: 'page:left' }] },
      { tier: 'grid', candidates: [{ point: { x: 100, y: 100 }, from: 'grid' }] }
    ]
    const result = snapToTiers(desired, tiers, 8)
    expect(result.tier).toBe('edge')
    expect(result.point).toEqual({ x: 104, y: 100 })
  })

  it('所有档都超出阈值时保持原位并报告 tier=null', () => {
    const desired = { x: 500, y: 500 }
    const result = snapToTiers(
      desired,
      [
        { tier: 'anchor', candidates: [{ point: { x: 0, y: 0 }, from: 'a:top-left' }] },
        { tier: 'edge', candidates: [] },
        // 8px 网格离任意点的最远距离约 5.7px，所以这里把阈值收到 4 才可能全落空
        { tier: 'grid', candidates: gridCandidatesNear(desired) }
      ],
      4
    )
    expect(result.tier).toBeNull()
    expect(result.point).toEqual(desired)
    expect(result.snapped).toBeNull()
  })

  it('nearestAnchor 把点击点解释成最近的九点锚点', () => {
    expect(nearestAnchor(rect, { x: 300, y: 100 })).toBe('top-right')
    expect(nearestAnchor(rect, { x: 200, y: 150 })).toBe('center')
    expect(nearestAnchor(rect, { x: 100, y: 200 })).toBe('bottom-left')
    expect(nearestAnchor(rect, { x: 250, y: 120 })).toBe('top')
  })
})

describe('测量与微调', () => {
  it('measureBetween 给出距离、水平/竖直分量与中点', () => {
    const measurement = measureBetween({ x: 10, y: 20 }, { x: 40, y: 60 })
    expect(measurement.dx).toBe(30)
    expect(measurement.dy).toBe(40)
    expect(measurement.distance).toBe(50)
    expect(measurement.mid).toEqual({ x: 25, y: 40 })
  })

  it('nudgeNumber 按方向加减、可用 shift 走大步并夹在最小值', () => {
    expect(nudgeNumber(10, 1)).toBe(11)
    expect(nudgeNumber(10, -1)).toBe(9)
    expect(nudgeNumber(10, 1, 10)).toBe(20)
    expect(nudgeNumber(2, -1, 10, 0)).toBe(0)
  })
})

describe('令牌解析与样式安全', () => {
  it('令牌支持「组.键」与省略组的写法', () => {
    expect(resolveToken(tokens, 'color.brand.primary')).toBe('#2f6fed')
    expect(resolveToken(tokens, 'space.4')).toBe('24px')
    expect(resolveToken(tokens, 'text.heading')).toContain('600')
    expect(resolveToken(tokens, 'brand.primary')).toBe('#2f6fed')
    expect(resolveToken(tokens, '4')).toBe('24px')
    expect(resolveToken(tokens, 'nope.nope')).toBeNull()
    expect(resolveToken(tokens, '  ')).toBeNull()
  })

  it('resolveStyleValue：token 优先，找不到令牌回退 value，空值返回 null', () => {
    expect(resolveStyleValue(tokens, { token: 'color.text.primary', value: '#000' })).toBe('#111827')
    expect(resolveStyleValue(tokens, { token: 'nope', value: '#abc' })).toBe('#abc')
    expect(resolveStyleValue(tokens, { token: 'nope' })).toBeNull()
    expect(resolveStyleValue(tokens, '  ')).toBeNull()
    expect(resolveStyleValue(tokens, { value: '  ' })).toBeNull()
  })

  it('样式安全网拦下 url()/javascript:/expression()/@import，放行普通值', () => {
    expect(isSafeStyleValue('background: url(https://evil)')).toBe(false)
    expect(isSafeStyleValue('url(#x)')).toBe(false)
    expect(isSafeStyleValue('javascript:alert(1)')).toBe(false)
    expect(isSafeStyleValue('expression(alert(1))')).toBe(false)
    expect(isSafeStyleValue('@import url(x)')).toBe(false)
    expect(isSafeStyleValue('#2f6fed')).toBe(true)
    expect(isSafeStyleValue('translate(10px, 20px)')).toBe(true)
    expect(isSafeStyleProperty('onclick')).toBe(false)
    expect(isSafeStyleProperty('content')).toBe(false)
    expect(isSafeStyleProperty('background-image')).toBe(false)
    expect(isSafeStyleProperty('background-color')).toBe(true)
  })

  it('toCssPropertyName 支持 camelCase、kebab-case 与自定义属性', () => {
    expect(toCssPropertyName('flexDirection')).toBe('flex-direction')
    expect(toCssPropertyName('background-color')).toBe('background-color')
    expect(toCssPropertyName('--brand')).toBe('--brand')
    expect(toCssPropertyName('borderTopLeftRadius')).toBe('border-top-left-radius')
  })
})

describe('标签白名单', () => {
  const node = (type: DesignNode['type'], tag?: string): DesignNode =>
    tag === undefined ? { id: 'n', type } : { id: 'n', type, tag }

  it('默认标签按类型映射', () => {
    expect(elementTagFor(node('page'))).toBe('div')
    expect(elementTagFor(node('stack'))).toBe('div')
    expect(elementTagFor(node('text'))).toBe('p')
    expect(elementTagFor(node('heading'))).toBe('h2')
    expect(elementTagFor(node('button'))).toBe('button')
    expect(elementTagFor(node('input'))).toBe('input')
  })

  it('白名单内的语义标签生效，危险标签被忽略', () => {
    expect(elementTagFor(node('box', 'section'))).toBe('section')
    expect(elementTagFor(node('text', 'h3'))).toBe('h3')
    expect(elementTagFor(node('box', 'script'))).toBe('div')
    expect(elementTagFor(node('box', 'iframe'))).toBe('div')
    expect(elementTagFor(node('box', 'a'))).toBe('div')
    expect(elementTagFor(node('box', 'FORM'))).toBe('div')
    expect(elementTagFor(node('box', '  '))).toBe('div')
  })
})

describe('帧内绝对定位（style.x / style.y / style.w / style.h）', () => {
  it('接受纯数字与 px 后缀，负号/小数可用', () => {
    expect(parseFrameLength('120')).toBe(120)
    expect(parseFrameLength('120px')).toBe(120)
    expect(parseFrameLength(' 12.5 ')).toBe(12.5)
    expect(parseFrameLength('-8px')).toBe(-8)
    expect(parseFrameLength('0')).toBe(0)
  })

  it('拒绝 auto / 百分比 / calc / 空值（必须显式 px 数字）', () => {
    expect(parseFrameLength('auto')).toBeNull()
    expect(parseFrameLength('50%')).toBeNull()
    expect(parseFrameLength('calc(10px + 2px)')).toBeNull()
    expect(parseFrameLength('')).toBeNull()
    expect(parseFrameLength('12em')).toBeNull()
    expect(parseFrameLength('12px 4px')).toBeNull()
  })
})

describe('patch 摘要', () => {
  const ops: PatchOp[] = [
    { op: 'insert', parentId: 'root', node: { id: 'a', type: 'box' } },
    { op: 'replace', targetId: 'b', node: { id: 'b', type: 'box' } },
    { op: 'update', targetId: 'c', patch: { text: 'x' } },
    { op: 'remove', targetId: 'd' },
    { op: 'move', targetId: 'e', parentId: 'root' },
    { op: 'token', name: 'color', key: 'brand.primary', value: '#000' }
  ]

  it('summarizeOps 区分增/替/改/删与结构变更、令牌变更', () => {
    const changes = summarizeOps(ops)
    expect([...changes.inserted]).toEqual(['a'])
    expect([...changes.replaced]).toEqual(['b'])
    expect([...changes.updated]).toEqual(['c'])
    expect([...changes.removed]).toEqual(['d'])
    expect(changes.structural).toBe(true)
    expect(changes.tokensChanged).toBe(true)
    expect(changes.count).toBe(6)
  })

  it('flashTargets 覆盖新增/替换/更新，entranceTargets 只覆盖新增/替换', () => {
    const changes = summarizeOps(ops)
    expect(flashTargets(changes).sort()).toEqual(['a', 'b', 'c'])
    expect(entranceTargets(changes).sort()).toEqual(['a', 'b'])
  })

  it('空 op 数组不产生任何变更', () => {
    const changes = summarizeOps([])
    expect(changes.count).toBe(0)
    expect(flashTargets(changes)).toEqual([])
    expect(changes.structural).toBe(false)
  })
})

describe('树工具与显示格式', () => {
  const tree: DesignNode = {
    id: 'root',
    type: 'page',
    children: [
      {
        id: 'hero',
        type: 'stack',
        children: [{ id: 'title', type: 'heading' }]
      }
    ]
  }

  it('ancestorIds 返回 root → parent 的路径，不含自身', () => {
    expect(ancestorIds(tree, 'title')).toEqual(['root', 'hero'])
    expect(ancestorIds(tree, 'hero')).toEqual(['root'])
    expect(ancestorIds(tree, 'root')).toEqual([])
    expect(ancestorIds(tree, 'missing')).toEqual([])
  })

  it('formatPercent 四舍五入到整数百分比', () => {
    expect(formatPercent(0.6234)).toBe('62%')
    expect(formatPercent(1)).toBe('100%')
  })
})
