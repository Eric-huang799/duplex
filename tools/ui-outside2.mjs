import { chromium } from 'playwright-core'
const port = process.argv[2]
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = []
for (const c of b.contexts()) for (const p of c.pages()) pages.push(p)
const ui = pages.find((p) => p.url().startsWith('file:') && p.url().includes('index.html'))
const pops = () => ui.evaluate(() => document.querySelectorAll('.panel-pop').length)
const gear = ui.locator('[data-panel-toggle="model-access"]')
if (await pops()) { await ui.mouse.click(600, 800); await ui.waitForTimeout(250) }
console.log('baseline closed:', (await pops()) === 0)
await gear.click(); await ui.waitForTimeout(300)
console.log('opened:', await pops())
await ui.mouse.click(600, 800); await ui.waitForTimeout(300)
console.log('outside click closes:', (await pops()) === 0)
await gear.click(); await ui.waitForTimeout(300)
await ui.locator('.map-tab').nth(1).click(); await ui.waitForTimeout(350)
await ui.screenshot({ path: process.env.TEMP + '\\duplex-final.png' })
console.log('shot saved')
await b.close()
