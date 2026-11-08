// 用 CDP 驱动 Duplex 的**应用界面**（不是网页标签），验证头部下拉是否真的能点开。
// 用法：node tools/ui-probe.mjs <devtoolsPort>
import { chromium } from 'playwright-core'

const port = process.argv[2]
if (!port) {
  console.error('缺少端口参数')
  process.exit(1)
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = []
for (const context of browser.contexts()) for (const page of context.pages()) pages.push(page)

const isAppUi = (url) => url.startsWith('file://') || url.includes('localhost') === false
console.log('pages:', pages.map((p) => p.url()))

// 应用界面是 file:// 加载的 out/renderer/index.html
const ui = pages.find((p) => p.url().includes('index.html') && p.url().startsWith('file:')) ?? pages[0]
if (!ui) {
  console.error('没有找到应用界面页面')
  process.exit(1)
}
console.log('ui url:', ui.url())

const before = await ui.evaluate(() => ({
  hasGear: !!document.querySelector('[data-panel-toggle="model-access"]'),
  gearRect: (() => {
    const el = document.querySelector('[data-panel-toggle="model-access"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  })(),
  panelPop: !!document.querySelector('.panel-pop'),
  statusRect: (() => {
    const el = document.querySelector('.panel-status')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), scrollW: el.scrollWidth }
  })()
}))
console.log('before:', JSON.stringify(before))

// 真正点一次（用 CDP 的真实鼠标事件）
await ui.locator('[data-panel-toggle="model-access"]').click({ timeout: 3000 })
await ui.waitForTimeout(300)

const afterOpen = await ui.evaluate(() => {
  const pop = document.querySelector('.panel-pop')
  const rect = pop ? pop.getBoundingClientRect() : null
  const center = rect ? { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + 12) } : null
  const hit = center ? document.elementFromPoint(center.x, center.y) : null
  return {
    panelPop: !!pop,
    rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
    zIndex: pop ? getComputedStyle(pop).zIndex : null,
    position: pop ? getComputedStyle(pop).position : null,
    // 浮层正中间那个点，实际命中的是谁？（判断是否被别的层盖住）
    hitTag: hit ? `${hit.tagName}.${hit.className}`.slice(0, 80) : null,
    tabs: [...document.querySelectorAll('.map-tab')].map((b) => b.textContent?.trim()),
    bodyText: (document.querySelector('.map-body')?.textContent ?? '').slice(0, 80)
  }
})
console.log('afterOpen:', JSON.stringify(afterOpen, null, 2))

// 点第二个 tab（站点授权）
const tabs = ui.locator('.map-tab')
if ((await tabs.count()) >= 2) {
  await tabs.nth(1).click({ timeout: 3000 })
  await ui.waitForTimeout(400)
  const afterTab = await ui.evaluate(() => ({
    selected: [...document.querySelectorAll('.map-tab')].find((b) => b.getAttribute('aria-selected') === 'true')?.textContent?.trim(),
    bodyText: (document.querySelector('.map-body')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120)
  }))
  console.log('afterTab:', JSON.stringify(afterTab, null, 2))
}

const shot = process.env.TEMP ? `${process.env.TEMP}\\duplex-ui-probe.png` : 'duplex-ui-probe.png'
await ui.screenshot({ path: shot })
console.log('screenshot:', shot)
await browser.close()

