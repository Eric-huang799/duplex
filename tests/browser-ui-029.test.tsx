import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

// No DOM test package is needed: exercise component event handlers across
// renders while preserving the hook state and refs that bind an edit to a tab.
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as Array<() => void | (() => void)> }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect) },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++
      hooks.cells[index] ??= { current: initial }
      return hooks.cells[index]
    },
    useState: (initial: unknown) => {
      const index = hooks.cursor++
      if (!(index in hooks.cells)) hooks.cells[index] = typeof initial === 'function' ? initial() : initial
      return [hooks.cells[index], (value: unknown) => { hooks.cells[index] = value }]
    }
  }
})

import { Toolbar } from '../src/renderer/src/components/Toolbar'
import { StartPage } from '../src/renderer/src/components/StartPage'
import { ExternalToolPanel } from '../src/renderer/src/components/ExternalToolPanel'
import type { ExternalSessionState } from '../src/shared/protocol'

type Node = ReactElement<{ children?: unknown; className?: string; onFocus?: Function; onChange?: Function; onKeyDown?: Function }>
function input(node: unknown, className?: string): Node | undefined {
  if (Array.isArray(node)) return node.map((child) => input(child, className)).find(Boolean)
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined
  const element = node as Node
  if (element.type === 'input' && (!className || element.props.className === className)) return element
  return input(element.props.children, className)
}

beforeEach(() => {
  hooks.cells = []
  hooks.cursor = 0
  hooks.effects = []
  vi.stubGlobal('window', { cobrowse: { getPlatform: () => 'win32' } })
  vi.stubGlobal('document', { activeElement: { blur() {} } })
})

describe('browser input targeting', () => {
  it('takes an external session from main state and leaves it open when the panel unmounts', async () => {
    const requests: string[] = []
    let listener: ((state: ExternalSessionState | null) => void) | undefined
    const opened: unknown[] = []
    vi.stubGlobal('window', { clearTimeout() {}, cobrowse: {
      agentsSessions: async () => [], agentsModels: async () => ({ candidates: [], current: '' }),
      agentsSessionClose: () => { requests.push('close'); return Promise.resolve({ ok: true }) },
      agentsSetMirrorSource: () => { requests.push('change source'); return Promise.resolve({ ok: true }) },
      onExternalState: (cb: typeof listener) => { listener = cb; return () => { listener = undefined } },
      externalState: async () => ({ toolId: 'codex', sessionId: 'session-1', title: 'Research', file: 'session.jsonl' }),
      onAgentsWatchError: () => () => {}
    } })
    ExternalToolPanel({ toolId: 'codex', tool: null, onCollapse() {}, onToolRemoved() {}, onOpenedChange: (state) => opened.push(state) })
    const cleanup = hooks.effects.map((effect) => effect())
    await Promise.resolve()
    expect(opened).toEqual([{ id: 'session-1', title: 'Research' }])
    listener?.({ toolId: 'codex', sessionId: 'session-2', title: 'Next', file: 'next.jsonl' })
    expect(opened.at(-1)).toEqual({ id: 'session-2', title: 'Next' })
    cleanup.forEach((dispose) => { if (typeof dispose === 'function') dispose() })
    expect(requests).toEqual([])
  })

  it('submits the address to the original tab after AI switches the visible tab', () => {
    const actions: unknown[] = []
    const render = (id: number) => {
      hooks.cursor = 0
      return input(Toolbar({ active: { id, url: `https://tab${id}.example` } as never,
        onAction: (...args) => actions.push(args) }), 'urlbar')!
    }
    let field = render(10)
    field.props.onFocus!({ currentTarget: { select() {} } })
    field.props.onChange!({ target: { value: 'https://human-search.example' } })
    field = render(20)
    field.props.onKeyDown!({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false } })
    expect(actions).toEqual([['navigate', 'https://human-search.example', 10]])
  })

  it('does not submit an address while Enter confirms a Chinese composition', () => {
    const onAction = vi.fn()
    const render = () => {
      hooks.cursor = 0
      return input(Toolbar({ active: { id: 10 } as never, onAction }), 'urlbar')!
    }
    render().props.onChange!({ target: { value: '研究' } })
    render().props.onKeyDown!({ key: 'Enter', keyCode: 229, nativeEvent: { isComposing: true } })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('does not search from the start page while Enter confirms a Chinese composition', () => {
    const onNavigate = vi.fn()
    const render = () => { hooks.cursor = 0; return input(StartPage({ onNavigate }))! }
    render().props.onChange!({ target: { value: '研究' } })
    render().props.onKeyDown!({ key: 'Enter', keyCode: 229, nativeEvent: { isComposing: true } })
    expect(onNavigate).not.toHaveBeenCalled()
    render().props.onKeyDown!({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false } })
    expect(onNavigate).toHaveBeenCalledWith('研究')
  })
})
