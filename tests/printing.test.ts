import { describe, expect, it, vi } from 'vitest'
import {
  printPage,
  savePageAsPdf,
  suggestedPdfName,
  type PrintableContents
} from '../src/main/printing'

/** 未显式覆盖的方法默认是 vi.fn()，测试只关心自己注入的那条路径。 */
function fakeContents(overrides: Partial<PrintableContents> = {}): PrintableContents {
  return {
    print: vi.fn(),
    printToPDF: vi.fn(),
    ...overrides
  }
}

describe('printPage', () => {
  it('打印成功时 resolve ok，并且默认弹系统打印对话框（silent=false）', async () => {
    const print = vi.fn(
      (_options: Record<string, unknown>, callback: (success: boolean, reason?: string) => void) => {
        callback(true)
      }
    )
    const outcome = await printPage(fakeContents({ print }))
    expect(outcome).toEqual({ ok: true })
    expect(print).toHaveBeenCalledTimes(1)
    expect(print).toHaveBeenCalledWith({ silent: false }, expect.any(Function))
  })

  it('silent 与 deviceName 原样传给 webContents.print', async () => {
    const print = vi.fn(
      (_options: Record<string, unknown>, callback: (success: boolean) => void) => {
        callback(true)
      }
    )
    await printPage(fakeContents({ print }), { silent: true, deviceName: ' Microsoft Print to PDF ' })
    expect(print).toHaveBeenCalledWith(
      { silent: true, deviceName: 'Microsoft Print to PDF' },
      expect.any(Function)
    )
  })

  it('用户取消（success=false, reason=cancelled）归一成可读中文', async () => {
    const print = vi.fn(
      (_options: Record<string, unknown>, callback: (success: boolean, reason?: string) => void) => {
        callback(false, 'cancelled')
      }
    )
    const outcome = await printPage(fakeContents({ print }))
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('取消')
  })

  it('success=false 且没有原因时也给出可读错误', async () => {
    const print = vi.fn(
      (_options: Record<string, unknown>, callback: (success: boolean) => void) => {
        callback(false)
      }
    )
    const outcome = await printPage(fakeContents({ print }))
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('打印失败：系统没有返回原因')
  })

  it('print 同步抛错时 resolve 为失败，而不是 reject', async () => {
    const print = vi.fn(() => {
      throw new Error('printer offline')
    })
    const outcome = await printPage(fakeContents({ print }))
    expect(outcome).toEqual({ ok: false, error: '打印失败：printer offline' })
  })

  it('回调重复触发时只落定第一次', async () => {
    const print = vi.fn(
      (_options: Record<string, unknown>, callback: (success: boolean, reason?: string) => void) => {
        callback(false, 'cancelled')
        callback(true)
      }
    )
    const outcome = await printPage(fakeContents({ print }))
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('取消')
  })
})

describe('savePageAsPdf', () => {
  it('默认 A4 + 背景色，并把 Buffer 原样返回', async () => {
    const pdf = Buffer.from('%PDF-1.4 test')
    const printToPDF = vi.fn(async () => pdf)
    const outcome = await savePageAsPdf(fakeContents({ printToPDF }))
    expect(outcome).toEqual({ ok: true, data: pdf })
    expect(printToPDF).toHaveBeenCalledWith({
      pageSize: 'A4',
      printBackground: true,
      landscape: false
    })
  })

  it('显式选项覆盖默认值', async () => {
    const printToPDF = vi.fn(async () => Buffer.from('%PDF-1.4 letter'))
    await savePageAsPdf(fakeContents({ printToPDF }), {
      pageSize: 'Letter',
      landscape: true,
      printBackground: false
    })
    expect(printToPDF).toHaveBeenCalledWith({
      pageSize: 'Letter',
      printBackground: false,
      landscape: true
    })
  })

  it('printToPDF 拒绝时返回 ok:false，不抛异常', async () => {
    const printToPDF = vi.fn(async () => {
      throw new Error('no printer available')
    })
    const outcome = await savePageAsPdf(fakeContents({ printToPDF }))
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('no printer available')
  })

  it('printToPDF 同步抛错同样归一成失败', async () => {
    const printToPDF = vi.fn(() => {
      throw new Error('webContents destroyed')
    })
    const outcome = await savePageAsPdf(fakeContents({ printToPDF }))
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('webContents destroyed')
  })

  it('拿不到 Buffer 时不当作成功', async () => {
    const printToPDF = vi.fn(async () => undefined as unknown as Buffer)
    const outcome = await savePageAsPdf(fakeContents({ printToPDF }))
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('PDF 数据')
  })
})

describe('suggestedPdfName', () => {
  const now = new Date(2026, 10, 8, 15, 30)

  it('日期取自注入的 now，中文标题原样保留', () => {
    expect(suggestedPdfName('季度报告', now)).toBe('2026-11-08_季度报告.pdf')
  })

  it('每个非法文件名字符都替换成下划线', () => {
    expect(suggestedPdfName('a\\b/c:d*e?f"g<h>i|j', now)).toBe(
      '2026-11-08_a_b_c_d_e_f_g_h_i_j.pdf'
    )
  })

  it('标题只由非法字符组成时结果仍然可读', () => {
    expect(suggestedPdfName('///', now)).toBe('2026-11-08____.pdf')
  })

  it('去掉首尾的空白与点', () => {
    expect(suggestedPdfName('  ..最终版. .  ', now)).toBe('2026-11-08_最终版.pdf')
  })

  it('空标题 / 纯空白 / 纯点都退回 page', () => {
    expect(suggestedPdfName(undefined, now)).toBe('2026-11-08_page.pdf')
    expect(suggestedPdfName('', now)).toBe('2026-11-08_page.pdf')
    expect(suggestedPdfName('   ', now)).toBe('2026-11-08_page.pdf')
    expect(suggestedPdfName('...', now)).toBe('2026-11-08_page.pdf')
  })

  it('超长标题截到 80 字符', () => {
    expect(suggestedPdfName('长'.repeat(100), now)).toBe(`2026-11-08_${'长'.repeat(80)}.pdf`)
  })

  it('标题里的相对路径不会逃出目标目录', () => {
    expect(suggestedPdfName('../../etc/passwd', now)).toBe('2026-11-08__.._etc_passwd.pdf')
  })

  it('now 缺省时使用当前日期', () => {
    const today = new Date()
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    expect(suggestedPdfName('首页')).toBe(`${stamp}_首页.pdf`)
  })
})
