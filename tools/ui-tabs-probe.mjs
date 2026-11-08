// 逐个点「模型与授权」里的 tab，看哪一个会导致面板消失，并抓渲染层报错。
import { chromium } from 'playwright-core'

const port = process.argv[2]
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = []
for (const context of browser.contexts()) for (const page of context.pages()) pages.push(page)
const ui = pages.find((p) => p.url().includes('index.html') && p.url().startsWith('file:'))
if (!ui) {
  console.error('没找到应用界面')
  process.exit(1)
}

const errors = []
ui.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text().slice(0, 200))
})
ui.on('pageerror', (err) => errors.push(`pageerror: ${err.message.slice(0, 200)}`))

const snap = async (label) => {
  const state = await ui.evaluate(() => ({
    pop: !!document.querySelector('.panel-pop'),
    tabs: [...document.querySelectorAll('.map-tab')].length,
    selected: [...document.querySelectorAll('.map-tab')].find((b) => b.getAttribute('aria-selected') === 'true')?.textContent?.trim() ?? null,
    body: (document.querySelector('.map-body')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60),
    backdrop: !!document.querySelector('.panel-pop-backdrop')
  }))
  console.log(label, JSON.stringify(state))
}

// 确保面板是打开的：先点开（若已开则先关再开）
const gear = ui.locator('[data-panel-toggle="model-access"]')
if (await ui.locator('.panel-pop').count()) {
  await gear.click()
  await ui.waitForTimeout(150)
}
await gear.click()
await ui.waitForTimeout(250)
await snap('opened:')

const tabs = ui.locator('.map-tab')
const count = await tabs.count()
console.log('tab count =', count)
for (let i = 0; i < count; i++) {
  const label = (await tabs.nth(i).textContent())?.trim()
  await tabs.nth(i).click({ timeout: 3000 })
  await ui.waitForTimeout(350)
  await snap(`after tab ${i} (${label}):`)
  // 若面板被关掉，重新打开再继续
  if (!(await ui.locator('.panel-pop').count())) {
    await gear.click()
    await ui.waitForTimeout(250)
    console.log('  (panel was closed -> reopened)')
  }
}

console.log('renderer errors:', JSON.stringify(errors.slice(0, 6), null, 2))
await browser.close()
