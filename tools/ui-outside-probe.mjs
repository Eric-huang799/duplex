import { chromium } from 'playwright-core'
const port = process.argv[2]
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = []
for (const c of b.contexts()) for (const p of c.pages()) pages.push(p)
const ui = pages.find((p) => p.url().startsWith('file:') && p.url().includes('index.html'))
const pops = () => ui.evaluate(() => document.querySelectorAll('.panel-pop').length)
await ui.locator('[data-panel-toggle="model-access"]').click()
await ui.waitForTimeout(300)
console.log('opened:', await pops())
await ui.mouse.click(600, 800)   // 点页面区域（侧栏之外）
await ui.waitForTimeout(300)
console.log('after clicking page outside panel:', await pops())
// 重新打开并截最终图
await ui.locator('[data-panel-toggle="model-access"]').click()
await ui.waitForTimeout(300)
await ui.screenshot({ path: process.env.TEMP + '\\duplex-final.png' })
console.log('shot:', process.env.TEMP + '\\duplex-final.png')
await b.close()
