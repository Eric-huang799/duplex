// 打开设计画布并检查渲染结果（验收用）。
import { chromium } from 'playwright-core'

const port = process.argv[2]
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = []
for (const context of browser.contexts()) for (const page of context.pages()) pages.push(page)
const ui = pages.find((p) => p.url().startsWith('file:') && p.url().includes('renderer/index.html'))
if (!ui) {
  console.error('找不到应用界面')
  process.exit(1)
}

const designBtn = ui.locator('button', { hasText: '设计' }).first()
const count = await designBtn.count()
console.log('设计按钮数量 =', count)
if (count > 0) {
  await designBtn.click()
  console.log('已点击"设计"')
}
await ui.waitForTimeout(3500)

// 重新枚举（画布是新标签）
const latest = []
for (const context of browser.contexts()) latest.push(...context.pages())
const canvas = latest.find((p) => p.url().includes('/canvas/'))
if (!canvas) {
  console.error('没有画布页面，当前页面：', latest.map((p) => p.url()))
  await browser.close()
  process.exit(1)
}
const info = await canvas.evaluate(() => ({
  url: location.href,
  host: typeof window.canvasHost,
  nodes: document.querySelectorAll('[data-did]').length,
  ids: [...document.querySelectorAll('[data-did]')].slice(0, 10).map((el) => el.getAttribute('data-did')),
  text: document.body.innerText.slice(0, 300)
}))
console.log(JSON.stringify(info, null, 2))
await canvas.screenshot({ path: `${process.env.TEMP}\\duplex-canvas.png` })
console.log('screenshot:', `${process.env.TEMP}\\duplex-canvas.png`)
await browser.close()
