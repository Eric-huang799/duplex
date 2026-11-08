import { chromium } from 'playwright-core'
const port = process.argv[2]
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = []
for (const c of browser.contexts()) for (const p of c.pages()) pages.push(p)
const ui = pages.find((p) => p.url().startsWith('file:') && p.url().includes('index.html'))
const gear = ui.locator('[data-panel-toggle="model-access"]')
const popCount = () => ui.evaluate(() => document.querySelectorAll('.panel-pop').length)

if (!(await popCount())) { await gear.click(); await ui.waitForTimeout(200) }
console.log('open?', await popCount())

// 取 tab 中心
const pt = await ui.evaluate(() => {
  const t = document.querySelectorAll('.map-tab')[1]
  const r = t.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})
console.log('tab center', pt)

await ui.mouse.move(pt.x, pt.y)
await ui.waitForTimeout(50)
console.log('after move ->', await popCount())
await ui.mouse.down()
await ui.waitForTimeout(120)
console.log('after mousedown ->', await popCount())
await ui.mouse.up()
await ui.waitForTimeout(200)
console.log('after mouseup ->', await popCount())

// 若还开着，点一下浮层标题区（非 tab），验证是否整体一点就关
if (await popCount()) {
  const headPt = await ui.evaluate(() => {
    const h = document.querySelector('.map-head')
    const r = h.getBoundingClientRect()
    return { x: Math.round(r.x + 20), y: Math.round(r.y + 8) }
  })
  await ui.mouse.click(headPt.x, headPt.y)
  await ui.waitForTimeout(200)
  console.log('after click map-head ->', await popCount())
}
await browser.close()
