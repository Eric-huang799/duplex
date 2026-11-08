import { chromium } from 'playwright-core'
const port = process.argv[2]
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = []
for (const c of browser.contexts()) for (const p of c.pages()) pages.push(p)
const ui = pages.find((p) => p.url().startsWith('file:') && p.url().includes('index.html'))
const state = () => ui.evaluate(() => ({
  model: !!document.querySelector('.map-tab'),
  playbooks: !!document.querySelector('.panel-pop') && (document.querySelector('.panel-pop')?.textContent ?? '').includes('分钟'),
  pops: document.querySelectorAll('.panel-pop').length,
  backdrops: document.querySelectorAll('.panel-pop-backdrop').length
}))
// 清掉可能开着的面板
if (await ui.locator('.panel-pop').count()) {
  await ui.mouse.click(400, 700)
  await ui.waitForTimeout(200)
}
await ui.locator('[data-panel-toggle="model-access"]').click()
await ui.waitForTimeout(200)
console.log('model open:', JSON.stringify(await state()))
// 打开预置任务：模型面板应被顶掉
await ui.locator('[data-panel-toggle="playbooks"]').click()
await ui.waitForTimeout(250)
console.log('after playbooks:', JSON.stringify(await state()))
// 截图（预置任务展开）
const shot = process.env.TEMP + '\\duplex-dropdown-check.png'
await ui.screenshot({ path: shot })
// 再切回站点权限并截图
await ui.locator('[data-panel-toggle="model-access"]').click()
await ui.waitForTimeout(200)
await ui.locator('.map-tab').nth(1).click()
await ui.waitForTimeout(300)
await ui.screenshot({ path: process.env.TEMP + '\\duplex-tab-sites.png' })
console.log('shots:', shot, process.env.TEMP + '\\duplex-tab-sites.png')
await browser.close()
