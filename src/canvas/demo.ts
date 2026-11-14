/**
 * 无宿主降级：内置演示文档 + 一个"假宿主"。
 *
 * 直接双击 `src/canvas/index.html` 的构建产物（或浏览器里打开预览）时，
 * `window.canvasHost` 不存在，main 会用它顶上：
 *  - 渲染一份演示文档；
 *  - 把画布要发的每条消息 `console.log` 出来（便于对齐契约）；
 *  - 本地模拟宿主行为：user-move → `style.x/y` 帧内定位 + 约束、user-update → patch、
 *    lock → meta.locked、undo/redo → 快照、commit-round → 轮次/脏标记。
 *
 * 它只用于开发/截图，不参与主进程的真实宿主逻辑。
 */

import {
  addConstraint,
  applyPatch,
  emptyDocument,
  findNode,
  type AnchorName,
  type DesignDocument,
  type DesignNode,
  type StyleTokenRef
} from '../shared/design/model'
import { parseFrameLength } from './geometry'
import type { CanvasHost, InboundMessage, OutboundMessage } from './host'

export interface DemoHostDeps {
  /** 画布当前渲染位置（layout 坐标），user-move / user-update 需要它算增量。 */
  measure(id: string): { x: number; y: number; width: number; height: number } | null
  emit(message: InboundMessage): void
  toast(text: string): void
}

export interface DemoHost extends CanvasHost {
  readonly isDemo: true
  pushVariants(): void
  destroy(): void
}

const round = (value: number): number => Math.round(value * 10) / 10

/** 演示文档里需要参与字符串拼接的颜色（令牌引用只能整体给一个属性用）。 */
const COLORS = {
  brand: '#2f6fed',
  line: '#e2e8f0',
  ink: '#0f172a'
}

function frameValue(node: DesignNode, key: 'x' | 'y' | 'w' | 'h'): number | null {
  const raw = node.style?.[key]
  if (!raw) return null
  const literal = typeof raw === 'string' ? raw : raw.value ?? ''
  return parseFrameLength(literal)
}

// ---------------------------------------------------------------- 演示文档

export function createDemoDocument(): DesignDocument {
  const doc = emptyDocument('Duplex 设计画布演示', 'demo-doc')
  doc.version = 7
  doc.updatedAt = 1_700_000_000_000
  doc.constraints = [
    {
      id: 'c1',
      kind: 'move',
      targetId: 'hero-title',
      target: { anchor: 'left', point: { x: 48, y: 250 }, frameWidth: 1440 },
      createdBy: 'user',
      at: 1_700_000_000_000,
      status: 'satisfied',
      note: '标题左对齐'
    }
  ]

  const token = (name: string): StyleTokenRef => ({ token: name })
  const heroCard = (mark: string, title: string): DesignNode => ({
    id: `preview-card-${mark}`,
    type: 'box',
    style: {
      background: 'rgba(255, 255, 255, 0.06)',
      border: '1px solid rgba(255, 255, 255, 0.12)',
      borderRadius: '12px',
      padding: '16px',
      minHeight: '88px'
    },
    children: [
      {
        id: `preview-card-${mark}-kicker`,
        type: 'text',
        tag: 'span',
        text: `SECTION ${mark}`,
        style: { fontSize: '11px', letterSpacing: '0.14em', color: 'rgba(255,255,255,0.52)' }
      },
      {
        id: `preview-card-${mark}-title`,
        type: 'text',
        text: title,
        style: { fontSize: '15px', fontWeight: '600', color: '#ffffff' }
      }
    ]
  })

  const feature = (index: number, title: string, copy: string): DesignNode => ({
    id: `feature-${index}`,
    type: 'stack',
    style: {
      padding: '22px',
      gap: '10px',
      background: '#ffffff',
      border: `1px solid ${COLORS.line}`,
      borderRadius: '16px'
    },
    children: [
      {
        id: `feature-${index}-index`,
        type: 'text',
        text: `0${index}`,
        style: { fontSize: '12px', fontWeight: '700', letterSpacing: '0.12em', color: token('color.brand.primary') }
      },
      { id: `feature-${index}-title`, type: 'heading', text: title, style: { fontSize: '18px' } },
      { id: `feature-${index}-copy`, type: 'text', text: copy, style: { fontSize: '14px', lineHeight: '1.65', color: token('color.text.muted') } }
    ]
  })

  doc.root.children = [
    {
      id: 'site-header',
      type: 'box',
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '20px 48px',
        borderBottom: `1px solid ${COLORS.line}`,
        background: '#ffffff'
      },
      meta: { createdBy: { actor: 'agent-1', step: 1, at: 1_700_000_000_000 } },
      children: [
        {
          id: 'brand-row',
          type: 'box',
          style: { display: 'flex', alignItems: 'center', gap: '10px' },
          children: [
            {
              id: 'brand-mark',
              type: 'box',
              style: {
                width: '28px',
                height: '28px',
                borderRadius: '8px',
                background: token('color.brand.primary')
              }
            },
            {
              id: 'brand-name',
              type: 'text',
              tag: 'span',
              text: 'Duplex',
              style: { fontSize: '18px', fontWeight: '700', letterSpacing: '-0.01em' }
            }
          ]
        },
        {
          id: 'site-nav',
          type: 'stack',
          style: { flexDirection: 'row', alignItems: 'center', gap: '28px' },
          children: [
            { id: 'nav-product', type: 'text', text: '产品', style: { fontSize: '14px', color: token('color.text.muted') } },
            { id: 'nav-design', type: 'text', text: '设计系统', style: { fontSize: '14px', color: token('color.text.muted') } },
            { id: 'nav-pricing', type: 'text', text: '定价', style: { fontSize: '14px', color: token('color.text.muted') } },
            {
              id: 'nav-cta',
              type: 'button',
              text: '开始使用',
              style: { padding: '10px 18px', fontSize: '14px', borderRadius: '999px' }
            }
          ]
        }
      ]
    },
    {
      id: 'hero',
      type: 'stack',
      style: {
        padding: '88px 48px 72px',
        gap: '22px',
        background: token('color.surface.alt')
      },
      meta: { createdBy: { actor: 'agent-1', step: 2, at: 1_700_000_000_000 } },
      children: [
        {
          id: 'hero-eyebrow',
          type: 'text',
          tag: 'span',
          text: 'DUPLEX · DESIGN CANVAS 0.3',
          style: {
            fontSize: '12px',
            fontWeight: '600',
            letterSpacing: '0.16em',
            color: token('color.brand.primary')
          }
        },
        {
          id: 'hero-title',
          type: 'heading',
          text: '把网页当作画布，\n和 AI 一起改',
          style: {
            fontSize: 'clamp(40px, 4.6vw, 64px)',
            lineHeight: '1.08',
            letterSpacing: '-0.03em',
            maxWidth: '820px',
            whiteSpace: 'pre-wrap'
          },
          meta: { createdBy: { actor: 'agent-1', step: 2, at: 1_700_000_000_000 } }
        },
        {
          id: 'hero-copy',
          type: 'text',
          text:
            '每一块都由节点树生成，带稳定的 data-did。你可以拖动、改数值、锁定，agent 的 patch 会绕开你的决定。',
          style: { fontSize: '18px', lineHeight: '1.7', maxWidth: '640px', color: token('color.text.muted') }
        },
        {
          id: 'hero-actions',
          type: 'stack',
          style: { flexDirection: 'row', gap: '12px', paddingTop: '6px' },
          children: [
            {
              id: 'hero-primary',
              type: 'button',
              text: '开始设计',
              style: { padding: '14px 22px', fontSize: '15px', borderRadius: '999px' }
            },
            {
              id: 'hero-secondary',
              type: 'button',
              text: '查看文档',
              style: {
                padding: '14px 22px',
                fontSize: '15px',
                borderRadius: '999px',
                background: '#ffffff',
                color: token('color.brand.primary'),
                border: `1px solid ${COLORS.line}`
              }
            }
          ]
        },
        {
          id: 'preview',
          type: 'box',
          style: {
            marginTop: '26px',
            background: '#0f172a',
            borderRadius: '20px',
            padding: '20px'
          },
          children: [
            {
              id: 'preview-grid',
              type: 'grid',
              style: { gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' },
              children: [
                heroCard('01', '可定位的区块'),
                heroCard('02', '可拖拽的布局'),
                heroCard('03', '可锁定的决定')
              ]
            }
          ]
        }
      ]
    },
    {
      id: 'features',
      type: 'stack',
      style: { padding: '64px 48px', gap: '24px', background: '#ffffff' },
      meta: { createdBy: { actor: 'agent-1', step: 3, at: 1_700_000_000_000 } },
      children: [
        {
          id: 'features-head',
          type: 'stack',
          style: { gap: '8px' },
          children: [
            {
              id: 'features-title',
              type: 'heading',
              text: '为「一起改」而生的设计画布',
              style: { fontSize: '32px', lineHeight: '1.2' }
            },
            {
              id: 'features-copy',
              type: 'text',
              text: '拖拽只发送意图，宿主把它翻译成约束；画布永远不直接改文档。',
              style: { fontSize: '15px', color: token('color.text.muted') }
            }
          ]
        },
        {
          id: 'feature-grid',
          type: 'grid',
          style: { gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' },
          children: [
            feature(1, '稳定定位', '每个节点都带 data-did，点击、检视、锁定都指向同一个 id。'),
            feature(2, '增量 patch', '新增与替换只做一次淡入，变动节点高亮 2 秒，删除直接移除。'),
            feature(3, '意图优先', '拖动、改数值、锁定都先发给宿主，由它决定怎么落到文档上。')
          ]
        }
      ]
    },
    {
      id: 'site-footer',
      type: 'box',
      style: {
        padding: '28px 48px',
        borderTop: `1px solid ${COLORS.line}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: '#ffffff'
      },
      meta: {
        createdBy: { actor: 'agent-1', step: 4, at: 1_700_000_000_000 },
        editedByUser: true
      },
      children: [
        { id: 'footer-copy', type: 'text', text: '© 2026 Duplex · 设计画布原型', style: { fontSize: '13px', color: token('color.text.muted') } },
        { id: 'footer-meta', type: 'text', text: 'frame 1440 · responsive preview', style: { fontSize: '13px', color: token('color.text.muted') } }
      ]
    }
  ]

  return doc
}

function createHeroVariants(): DesignNode[] {
  const base = (id: string, children: DesignNode[], style: Record<string, StyleTokenRef | string>): DesignNode => ({
    id,
    type: 'stack',
    style,
    children
  })

  return [
    base('variant-hero-a', [
      {
        id: 'variant-hero-a-title',
        type: 'heading',
        text: '把网页当作画布',
        style: { fontSize: '56px', letterSpacing: '-0.03em', lineHeight: '1.05' }
      },
      {
        id: 'variant-hero-a-copy',
        type: 'text',
        text: '经典左对齐首屏：标题 + 说明 + 主按钮。',
        style: { fontSize: '18px', color: { token: 'color.text.muted' } }
      },
      { id: 'variant-hero-a-cta', type: 'button', text: '开始设计', style: { borderRadius: '999px', padding: '14px 22px' } }
    ], { padding: '72px 48px', gap: '18px', background: { token: 'color.surface.alt' } }),
    base('variant-hero-b', [
      {
        id: 'variant-hero-b-title',
        type: 'heading',
        text: '和 AI 一起改',
        style: { fontSize: '52px', color: '#ffffff', letterSpacing: '-0.02em' }
      },
      {
        id: 'variant-hero-b-copy',
        type: 'text',
        text: '深色强调版：品牌色铺底，适合强 CTA。',
        style: { fontSize: '18px', color: 'rgba(255,255,255,0.78)' }
      },
      { id: 'variant-hero-b-cta', type: 'button', text: '立即体验', style: { borderRadius: '999px', padding: '14px 22px', background: '#ffffff', color: '#1d4ed8' } }
    ], { padding: '72px 48px', gap: '18px', background: '#1d4ed8' }),
    base('variant-hero-c', [
      {
        id: 'variant-hero-c-title',
        type: 'heading',
        text: '先定位，再改动',
        style: { fontSize: '44px', letterSpacing: '-0.02em' }
      },
      {
        id: 'variant-hero-c-copy',
        type: 'text',
        text: '双栏版：左侧文案，右侧三个数据点。',
        style: { fontSize: '17px', color: { token: 'color.text.muted' } }
      },
      {
        id: 'variant-hero-c-grid',
        type: 'grid',
        style: { gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', paddingTop: '12px' },
        children: [
          { id: 'variant-hero-c-stat-1', type: 'box', text: '9 点锚点', style: { padding: '16px', border: '1px solid #dbe3f0', borderRadius: '12px', fontSize: '14px' } },
          { id: 'variant-hero-c-stat-2', type: 'box', text: '8px 网格', style: { padding: '16px', border: '1px solid #dbe3f0', borderRadius: '12px', fontSize: '14px' } },
          { id: 'variant-hero-c-stat-3', type: 'box', text: '2s 高亮', style: { padding: '16px', border: '1px solid #dbe3f0', borderRadius: '12px', fontSize: '14px' } }
        ]
      }
    ], { padding: '72px 48px', gap: '16px', background: '#ffffff' })
  ]
}

// ---------------------------------------------------------------- 假宿主

export function createDemoHost(deps: DemoHostDeps): DemoHost {
  let doc = createDemoDocument()
  let roundIndex = 3
  let dirty = false
  let handler: ((message: InboundMessage) => void) | null = null
  const queue: InboundMessage[] = []
  const undoStack: DesignDocument[] = []
  const redoStack: DesignDocument[] = []
  let pendingVariants: { blockId: string; options: DesignNode[] } | null = null

  function emit(message: InboundMessage): void {
    if (handler) handler(message)
    else queue.push(message)
  }

  function emitDocument(): void {
    emit({ type: 'document', doc })
  }

  function emitState(): void {
    emit({ type: 'state', round: roundIndex, dirty, actor: dirty ? 'user' : 'agent-1' })
  }

  function pushHistory(previous: DesignDocument): void {
    undoStack.push(previous)
    if (undoStack.length > 80) undoStack.shift()
    redoStack.length = 0
  }

  function commit(next: DesignDocument, toastText: string): void {
    if (next === doc) return
    pushHistory(doc)
    doc = next
    dirty = true
    emitDocument()
    emitState()
    deps.toast(toastText)
  }

  function userActor(): { actor: string; step: number; at: number } {
    return { actor: 'user', step: roundIndex, at: Date.now() }
  }

  function handleMove(message: Extract<OutboundMessage, { type: 'user-move' }>): void {
    const node = findNode(doc.root, message.id)
    if (!node) return
    // 画布已经把"当前设计帧包围盒"带过来了，宿主这边不需要再量一遍
    const rect = message.rect
    const delta = {
      x: message.target.x - (rect.x + rect.width / 2),
      y: message.target.y - (rect.y + rect.height / 2)
    }
    const next = applyPatch(
      doc,
      [
        {
          op: 'update',
          targetId: message.id,
          patch: {
            style: {
              // 帧内绝对定位：left/top 直接落在设计帧坐标系
              x: String(round(rect.x + delta.x)),
              y: String(round(rect.y + delta.y)),
              w: String(round(rect.width))
            }
          }
        }
      ],
      userActor(),
      { allowLocked: true }
    ).document
    const withConstraint = addConstraint(next, {
      kind: 'move',
      targetId: message.id,
      target: {
        anchor: message.anchor as AnchorName,
        point: message.target,
        frameWidth: message.frameWidth
      },
      createdBy: 'user'
    })
    commit(withConstraint, `演示宿主：已把 ${message.id} 放到 (${Math.round(rect.x + delta.x)}, ${Math.round(rect.y + delta.y)})`)
  }

  function handleLocate(message: Extract<OutboundMessage, { type: 'user-locate' }>): void {
    const node = findNode(doc.root, message.targetId)
    if (!node) return
    const next = addConstraint(doc, {
      kind: 'move',
      targetId: message.targetId,
      target: {
        anchor: message.anchor as AnchorName,
        point: message.point,
        frameWidth: message.frameWidth
      },
      createdBy: 'user',
      note: '定位器确认'
    })
    commit(next, `演示宿主：已记录 ${message.targetId} 的定位意图（${message.anchor}）`)
  }

  function handleUpdate(message: Extract<OutboundMessage, { type: 'user-update' }>): void {
    const node = findNode(doc.root, message.id)
    if (!node) return
    const rect = deps.measure(message.id)
    const style: Record<string, StyleTokenRef | string> = {}
    const patchText = typeof message.patch.text === 'string' ? message.patch.text : undefined

    if (typeof message.patch.width === 'number') style.w = String(round(message.patch.width))
    if (typeof message.patch.height === 'number') style.h = String(round(message.patch.height))

    const wantsX = typeof message.patch.x === 'number'
    const wantsY = typeof message.patch.y === 'number'
    if (rect && (wantsX || wantsY)) {
      // 用帧内绝对定位落地：先补齐另一轴/宽度，避免从 flex 流里被"缩窄"
      const baseX = frameValue(node, 'x') ?? rect.x
      const baseY = frameValue(node, 'y') ?? rect.y
      style.x = String(round(wantsX ? (message.patch.x as number) : baseX))
      style.y = String(round(wantsY ? (message.patch.y as number) : baseY))
      if (style.w === undefined && frameValue(node, 'w') === null) {
        style.w = String(round(rect.width))
      }
    }

    if (patchText === undefined && Object.keys(style).length === 0) return
    const next = applyPatch(
      doc,
      [
        {
          op: 'update',
          targetId: message.id,
          patch: {
            ...(patchText === undefined ? {} : { text: patchText }),
            ...(Object.keys(style).length === 0 ? {} : { style }),
            meta: { editedByUser: true }
          }
        }
      ],
      userActor(),
      { allowLocked: true }
    ).document
    commit(next, '演示宿主：已应用 user-update')
  }

  function handleLock(message: Extract<OutboundMessage, { type: 'lock' }>): void {
    const next = applyPatch(
      doc,
      [{ op: 'update', targetId: message.id, patch: { meta: { locked: message.locked } } }],
      userActor(),
      { allowLocked: true }
    ).document
    commit(next, message.locked ? '演示宿主：节点已锁定' : '演示宿主：节点已解锁')
  }

  function handleVariantChoose(message: Extract<OutboundMessage, { type: 'variant-choose' }>): void {
    if (!pendingVariants || pendingVariants.blockId !== message.blockId) return
    const option = pendingVariants.options[message.index]
    if (!option) return
    const next = structuredClone(doc)
    const existing = next.variants.find((variant) => variant.blockId === message.blockId)
    if (existing) {
      existing.chosenIndex = message.index
    } else {
      next.variants.push({
        blockId: message.blockId,
        options: pendingVariants.options,
        chosenIndex: message.index
      })
    }
    next.version += 1
    next.updatedAt = Date.now()
    pendingVariants = null
    commit(next, `演示宿主：已选择方案 ${String.fromCharCode(65 + message.index)}（${option.id}）`)
  }

  function handleUndo(): void {
    const previous = undoStack.pop()
    if (!previous) {
      deps.toast('演示宿主：没有可撤销的步骤')
      return
    }
    redoStack.push(doc)
    doc = previous
    dirty = true
    emitDocument()
    emitState()
    deps.toast('演示宿主：已撤销')
  }

  function handleRedo(): void {
    const next = redoStack.pop()
    if (!next) {
      deps.toast('演示宿主：没有可重做的步骤')
      return
    }
    undoStack.push(doc)
    doc = next
    dirty = true
    emitDocument()
    emitState()
    deps.toast('演示宿主：已重做')
  }

  const host: DemoHost = {
    isDemo: true,
    ready(): void {
      console.log('[canvas → host] ready()')
      window.setTimeout(() => {
        emitDocument()
        emitState()
      }, 0)
    },
    send(message: OutboundMessage): void {
      // 契约走查用：把画布发出的每条消息打印出来
      console.log('[canvas → host]', message)
      switch (message.type) {
        case 'user-move':
          handleMove(message)
          break
        case 'user-locate':
          handleLocate(message)
          break
        case 'user-update':
          handleUpdate(message)
          break
        case 'lock':
          handleLock(message)
          break
        case 'variant-choose':
          handleVariantChoose(message)
          break
        case 'viewport':
          console.log(`[canvas → host] 视口切换为 ${message.width}px（演示宿主只记录，不落文档）`)
          break
        case 'undo':
          handleUndo()
          break
        case 'redo':
          handleRedo()
          break
        case 'commit-round': {
          const summary = message.summary.trim() || '手动调整'
          roundIndex += 1
          dirty = false
          emitState()
          deps.toast(`演示宿主：第 ${roundIndex} 轮已提交 — ${summary}`)
          break
        }
        case 'export':
          console.log('[canvas → host] 导出演示文档：', JSON.stringify(doc, null, 2))
          deps.toast('演示宿主：已把文档 JSON 打印到控制台')
          break
        case 'select':
          break
        default:
          break
      }
    },
    on(nextHandler: (message: InboundMessage) => void): void {
      handler = nextHandler
      while (queue.length > 0) {
        const message = queue.shift()
        if (message) nextHandler(message)
      }
    },
    pushVariants(): void {
      const options = createHeroVariants()
      pendingVariants = { blockId: 'hero', options }
      emit({ type: 'variants', blockId: 'hero', options })
    },
    destroy(): void {
      handler = null
      queue.length = 0
    }
  }

  return host
}

