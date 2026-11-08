import { chromium } from 'playwright-core'
const port = process.argv[2]
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = []
for (const c of browser.contexts()) for (const p of c.pages()) pages.push(p)
const ui = pages.find((p) => p.url().startsWith('file:') && p.url().includes('index.html'))
const gear = ui.locator('[data-panel-toggle="model-access"]')
if (!(await ui.locator('.panel-pop').count())) { await gear.click(); await ui.waitForTimeout(250) }
const info = await ui.evaluate(() => {
  const tab = document.querySelectorAll('.map-tab')[1]
  const r = tab?.getBoundingClientRect()
  const cx = r ? Math.round(r.x + r.width / 2) : 0
  const cy = r ? Math.round(r.y + r.height / 2) : 0
  const hit = document.elementFromPoint(cx, cy)
  const pop = document.querySelector('.panel-pop')
  const popRect = pop?.getBoundingClientRect()
  return {
    tabRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    hitAtTabCenter: hit ? hit.tagName + '.' + String(hit.className).slice(0, 60) : null,
    popRect: popRect ? { x: Math.round(popRect.x), y: Math.round(popRect.y), w: Math.round(popRect.width), h: Math.round(popRect.height) } : null,
    popZ: pop ? getComputedStyle(pop).zIndex : null,
    popPointer: pop ? getComputedStyle(pop).pointerEvents : null,
    backdropZ: (() => { const b = document.querySelector('.panel-pop-backdrop'); return b ? getComputedStyle(b).zIndex : null })(),
    panelZ: getComputedStyle(document.querySelector('.panel')).zIndex,
    panelTransform: getComputedStyle(document.querySelector('.panel')).transform
  }
})
console.log(JSON.stringify(info, null, 2))
await browser.close()
