// 验收探针：驱动应用界面点「并行演示」，验证徽标出现、两个会话真的在跑、页面状态正确。
// 用法：node tools/parallel-ui-check.mjs <devtoolsPort>
import { chromium } from 'playwright-core'

const port = process.argv[2]
if (!port) {
  console.error('用法：node tools/parallel-ui-check.mjs <devtoolsPort>')
  process.exit(1)
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = []
for (const context of browser.contexts()) for (const page of context.pages()) pages.push(page)
const ui = pages.find((page) => page.url().startsWith('file:') && page.url().includes('index.html'))
if (!ui) {
  console.error('没有找到应用界面页面')
  process.exit(1)
}

// 演示会新开一个探针页；取**最后一个**（也就是新开的、成为活动标签的那个），
// 否则会读到旧页面得到 clicks=0 的假阴性。
const probe = () => [...pages].reverse().find((page) => page.url().includes('127.0.0.1:8799'))

const badge = async () => {
  const el = await ui.$('.panel-parallel')
  return el ? (await el.textContent())?.trim() : null
}

// 1) 打开预置任务面板
await ui.locator('[data-panel-toggle="playbooks"]').click()
await ui.waitForTimeout(300)
// 2) 点「并行演示」
const demo = ui.locator('button', { hasText: '并行演示' }).first()
await demo.click()
console.log('已点击并行演示')

// 3) 观察徽标：最多 20 秒
let seenBadge = null
for (let i = 0; i < 40; i++) {
  await ui.waitForTimeout(500)
  const text = await badge()
  if (text) seenBadge = text
  if (seenBadge && !text) break
  if (i === 1) {
    const snap = pages.map((page) => page.url())
    console.log('页面：', JSON.stringify(snap))
  }
}

// 演示会新开标签：必须**重新枚举**页面，否则读的是点击演示之前的那批旧页面
const latestPages = []
for (const context of browser.contexts()) latestPages.push(...context.pages())
const probeStates = []
for (const page of latestPages) {
  if (!page.url().includes('127.0.0.1:8799')) continue
  try {
    probeStates.push(
      await page.evaluate(() => ({
        url: location.href,
        clicks: (window.__CLICKS__ && window.__CLICKS__.count) ?? -1,
        input: (document.querySelector('#probe-input') || {}).value || ''
      }))
    )
  } catch {
    /* page navigated */
  }
}
const final = probeStates.find((state) => state.clicks > 0 || state.input) ?? probeStates[0] ?? null
console.log('各探针页状态：', JSON.stringify(probeStates))

const shot = `${process.env.TEMP || '.'}\\duplex-parallel-verify.png`
await ui.screenshot({ path: shot })
console.log(
  JSON.stringify(
    { badgeSeen: seenBadge, badgeNow: await badge(), final, screenshot: shot },
    null,
    2
  )
)
await browser.close()
