import { chromium } from 'playwright-core'
const port = process.argv[2]
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = []
for (const c of b.contexts()) for (const p of c.pages()) pages.push(p)
const ui = pages.find((p) => p.url().startsWith('file:') && p.url().includes('index.html'))
const st = () => ui.evaluate(() => ({ pops: document.querySelectorAll('.panel-pop').length, model: !!document.querySelector('.map-tab'), playbooks: (document.querySelector('.panel-pop')?.textContent ?? '').includes('分钟') }))
console.log('start', JSON.stringify(await st()))
// 先确保全部关闭
await ui.mouse.click(600, 800); await ui.waitForTimeout(250)
console.log('after outside click', JSON.stringify(await st()))
await ui.locator('[data-panel-toggle="model-access"]').click(); await ui.waitForTimeout(350)
console.log('after gear#1', JSON.stringify(await st()))
await ui.locator('[data-panel-toggle="model-access"]').click(); await ui.waitForTimeout(250)
console.log('after gear#2', JSON.stringify(await st()))
await ui.locator('[data-panel-toggle="model-access"]').click(); await ui.waitForTimeout(250)
await ui.locator('[data-panel-toggle="playbooks"]').click(); await ui.waitForTimeout(300)
console.log('model->playbooks', JSON.stringify(await st()))
await ui.locator('[data-panel-toggle="model-access"]').click(); await ui.waitForTimeout(300)
console.log('playbooks->model', JSON.stringify(await st()))
await ui.locator('.map-tab').nth(1).click(); await ui.waitForTimeout(300)
await ui.screenshot({ path: process.env.TEMP + '\\duplex-final.png' })
await b.close()
