/**
 * 打印 /「另存为 PDF」的主进程封装。
 *
 * 为什么把依赖收窄成 PrintableContents：系统打印对话框、用户取消、驱动报错
 * 这几条分支在单测里都没法真实触发。只注入 `print` / `printToPDF` 两个方法，
 * 测试就能覆盖全部分支，接线时传 `tab.view.webContents` 也只是两行。
 *
 * 本模块刻意不 import electron，保持纯逻辑、可直接被 vitest 加载。
 */

/** 最小化的 webContents 依赖，便于单测注入。 */
export interface PrintableContents {
  print(options: Record<string, unknown>, callback: (success: boolean, reason?: string) => void): void
  printToPDF(options: Record<string, unknown>): Promise<Buffer>
}

export interface PrintOutcome {
  ok: boolean
  error?: string
}

export interface PdfOutcome {
  ok: boolean
  data?: Buffer
  error?: string
}

export interface PrintPageOptions {
  /** false = 弹系统打印对话框（默认）；true = 直接送去默认打印机。 */
  silent?: boolean
  /** 指定打印机；不传则用系统默认打印机。 */
  deviceName?: string
}

export interface SavePdfOptions {
  pageSize?: 'A4' | 'Letter'
  landscape?: boolean
  printBackground?: boolean
}

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g

/** 把回调里的失败原因翻译成用户能看懂的中文。 */
function describePrintFailure(reason?: string): string {
  const detail = (reason ?? '').trim()
  // Electron 在不同平台给的措辞是 cancelled / canceled，统一按"用户取消"处理
  if (/cancel/i.test(detail)) return '打印已取消'
  if (!detail) return '打印失败：系统没有返回原因'
  return `打印失败：${detail}`
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error.trim()
  return '未知错误'
}

export function printPage(
  contents: PrintableContents,
  options: PrintPageOptions = {}
): Promise<PrintOutcome> {
  // silent 固定传布尔值：省略时 Electron 的默认行为虽然也是弹对话框，但显式
  // 传入才能保证各平台驱动不会把"缺省"解释成静默打印。
  const printOptions: Record<string, unknown> = { silent: options.silent === true }
  if (options.deviceName?.trim()) printOptions.deviceName = options.deviceName.trim()

  return new Promise<PrintOutcome>((resolve) => {
    let settled = false
    // 回调与同步异常两条路径都可能落定，这里兜一层，避免 Promise 被 resolve 两次
    const settle = (outcome: PrintOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    try {
      contents.print(printOptions, (success, reason) => {
        if (success) settle({ ok: true })
        else settle({ ok: false, error: describePrintFailure(reason) })
      })
    } catch (error) {
      settle({ ok: false, error: `打印失败：${describeError(error)}` })
    }
  })
}

export async function savePageAsPdf(
  contents: PrintableContents,
  options: SavePdfOptions = {}
): Promise<PdfOutcome> {
  // 背景色默认打开：网页的视觉层次（深色底、表头底纹）几乎都靠 CSS 背景承载，
  // 关掉只会导出"白纸黑字"的残版。
  const pdfOptions: Record<string, unknown> = {
    pageSize: options.pageSize ?? 'A4',
    printBackground: options.printBackground !== false,
    landscape: options.landscape === true
  }
  try {
    const data = await contents.printToPDF(pdfOptions)
    // 防御异常返回值：把 undefined/字符串当成成功会让上层写出一个坏文件
    if (!Buffer.isBuffer(data)) return { ok: false, error: '导出 PDF 失败：没有拿到 PDF 数据' }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: `导出 PDF 失败：${describeError(error)}` }
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function suggestedPdfName(title: string | undefined, now: Date = new Date()): string {
  // 用本地日期而不是 toISOString()：文件名是给用户看的，UTC 会让晚上导出的
  // 文件看起来是"昨天"的。
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  const safe = (title ?? '')
    // 这些字符在 Windows 上直接非法，在 macOS/Linux 上也会让文件难以分享
    .replace(ILLEGAL_FILENAME_CHARS, '_')
    // 控制字符（标题里偶尔混入的换行）留着会生成一个打不开的文件名
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    // 首尾的空白与点会被系统静默裁掉；顺手也断掉 "../" 这类路径穿越
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 80)
    // 截断可能正好停在空格或点上，再清一次尾
    .replace(/[\s.]+$/, '')
  return `${stamp}_${safe || 'page'}.pdf`
}
