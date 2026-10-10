import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abortOperation, beginOperation, endOperation, runInOperation } from '../src/main/interrupt'

const page = vi.hoisted(() => ({ evalInPage: vi.fn() }))
vi.mock('../src/main/cdp', () => ({ evalInPage: page.evalInPage }))
import { createAnnotationSubmitHandler, type AnnotateInfo, type AnnotationDelivery } from '../src/main/annotations'

const info: AnnotateInfo = {
  url: 'https://source.example', title: 'Source', scroll: { x: 0, y: 0 }, viewport: { w: 900, h: 700 },
  elements: [], primary: [], anchor: null, text: 'Source content', points: [], elementCount: 0
}
const payload = {
  annotationId: 'annotation-1', tool: 'rect' as const, rect: { x: 10, y: 10, w: 100, h: 100 },
  tabId: 10, documentURL: 'https://source.example', documentToken: 'doc-10'
}
function fixture() {
  const source = { id: 10, view: { webContents: { getURL: () => 'https://source.example' } } }
  const active = { id: 20, view: { webContents: { getURL: () => 'https://other.example' } } }
  const delivered: AnnotationDelivery[] = []
  const tabs = { getTab: (id: number) => id === 10 ? source : id === 20 ? active : null, getActive: () => active }
  return { source, delivered, tabs }
}
beforeEach(() => { page.evalInPage.mockReset() })

describe('annotation source and cancellation', () => {
  it('does not fall back to the active tab when the source tab has closed', async () => {
    const { delivered, tabs } = fixture()
    const submit = createAnnotationSubmitHandler(tabs as never, {} as never, (delivery) => delivered.push(delivery))
    expect((await submit({ ...payload, tabId: 99 })).ok).toBe(false)
    expect(page.evalInPage).not.toHaveBeenCalled()
    expect(delivered).toEqual([])
  })

  it('rejects navigation to a different URL before sampling', async () => {
    const { delivered, tabs } = fixture()
    page.evalInPage.mockImplementation(async (_tab, expression) => expression.includes('data-duplex-document')
      ? { url: 'https://new.example', token: 'doc-10' } : { ...info, url: 'https://new.example' })
    const submit = createAnnotationSubmitHandler(tabs as never, {} as never, (delivery) => delivered.push(delivery))
    expect((await submit(payload)).ok).toBe(false)
    expect(delivered).toEqual([])
  })

  it('samples and delivers the originating tab when a different tab is active', async () => {
    const { source, delivered, tabs } = fixture()
    page.evalInPage.mockImplementation(async (tab, expression) => {
      return expression.includes('data-duplex-document')
        ? { url: 'https://source.example', token: 'doc-10' }
        : { ...info, text: tab === source ? 'Source content' : 'Wrong page' }
    })
    const submit = createAnnotationSubmitHandler(tabs as never, {} as never, (delivery) => delivered.push(delivery))
    expect(await submit(payload)).toEqual({ ok: true })
    expect(delivered[0]?.tabId).toBe(10)
    expect(delivered[0]?.text).toContain('Source content')
    expect(delivered[0]?.text).not.toContain('Wrong page')
  })

  it('rejects a replaced document even when its URL has not changed', async () => {
    const { delivered, tabs } = fixture()
    page.evalInPage.mockImplementation(async (_tab, expression) => expression.includes('data-duplex-document')
      ? { url: 'https://source.example', token: 'doc-reloaded' } : info)
    const submit = createAnnotationSubmitHandler(tabs as never, {} as never, (delivery) => delivered.push(delivery))
    expect((await submit(payload)).ok).toBe(false)
    expect(delivered).toEqual([])
  })

  it('does not deliver if the document changes while sampling', async () => {
    const { delivered, tabs } = fixture()
    let documentReads = 0
    page.evalInPage.mockImplementation(async (_tab, expression) => expression.includes('data-duplex-document')
      ? { url: 'https://source.example', token: ++documentReads === 1 ? 'doc-10' : 'doc-reloaded' } : info)
    const submit = createAnnotationSubmitHandler(tabs as never, {} as never, (delivery) => delivered.push(delivery))
    expect((await submit(payload)).ok).toBe(false)
    expect(delivered).toEqual([])
  })

  it('does not deliver after an emergency stop aborts the sampling operation', async () => {
    const { delivered, tabs } = fixture()
    const ac = beginOperation({ tabId: 10 })
    page.evalInPage.mockImplementation(async (_tab, expression) => {
      if (expression.includes('data-duplex-document')) return { url: 'https://source.example', token: 'doc-10' }
      abortOperation({ tabId: 10 })
      return info
    })
    const submit = createAnnotationSubmitHandler(tabs as never, {} as never, (delivery) => delivered.push(delivery))
    try {
      expect((await runInOperation(ac, () => submit(payload))).ok).toBe(false)
      expect(delivered).toEqual([])
    } finally { endOperation(ac) }
  })

  it('does not deliver when the AI becomes paused during sampling outside an operation', async () => {
    const { delivered, tabs } = fixture()
    let paused = false
    page.evalInPage.mockImplementation(async (_tab, expression) => {
      if (expression.includes('data-duplex-document')) return { url: 'https://source.example', token: 'doc-10' }
      paused = true
      return info
    })
    const submit = createAnnotationSubmitHandler(tabs as never, {} as never,
      (delivery) => delivered.push(delivery), { isAiPaused: () => paused })
    expect((await submit(payload)).ok).toBe(false)
    expect(delivered).toEqual([])
  })
})
