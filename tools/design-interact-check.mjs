// 验收：拖动元素（帧内绝对定位）、提交本轮、切换手机视口并截图。
import { chromium } from 'playwright-core'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const port = process.argv[2]
const dataDir = process.env.DUPLEX_DATA_DIR
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = []
for (const context of browser.contexts()) for (const page of context.pages()) pages.push(page)
const canvas = pages.find((p) => p.url().includes('/canvas/'))
if (!canvas) {
  console.error('没有画布页面')
  process.exit(1)
}

/** 找出被绝对定位（style 里有 position:absolute）的节点。 */
const absoluteNodes = () =>
  canvas.evaluate(() =>
    [...document.querySelectorAll('[data-did]')]
      .filter((el) => (el.getAttribute('style') ?? '').includes('absolute'))
      .map((el) => ({ id: el.getAttribute('data-did'), style: el.getAttribute('style') }))
  )

console.log('拖动前绝对定位节点 =', JSON.stringify(await absoluteNodes()))

const box = await canvas.locator('[data-did="card-b"]').boundingBox()
if (!box) {
  console.error('card-b 没有包围盒')
  process.exit(1)
}
// 从卡片内边距处起拖，避免直接抓到子文本（子元素拖动语义不同）
const startX = box.x + 12
const startY = box.y + 12
await canvas.mouse.move(startX, startY)
await canvas.mouse.down()
for (let i = 1; i <= 8; i++) {
  await canvas.mouse.move(startX + i * 18, startY + i * 8)
  await canvas.waitForTimeout(35)
}
await canvas.mouse.up()
await canvas.waitForTimeout(700)
console.log('拖动后绝对定位节点 =', JSON.stringify(await absoluteNodes()))

// 提交本轮（工具栏的提交框是文本输入，不是宽度滑杆）
await canvas.locator('button', { hasText: '提交本轮' }).first().click().catch(() => undefined)
await canvas.waitForTimeout(300)
const textInput = canvas.locator('input[type="text"], input:not([type="range"])').first()
if ((await textInput.count()) > 0) {
  await textInput.fill('验收：把特性卡 B 拖到右下方')
  await canvas.keyboard.press('Enter')
  await canvas.waitForTimeout(1500)
}
const state = await canvas.evaluate(() => document.body.innerText.match(/第 \d+ 轮[^\n]*/)?.[0] ?? '')
console.log('状态栏 =', state)

// 切到手机视口
await canvas.locator('button', { hasText: '手机' }).first().click().catch(() => undefined)
await canvas.waitForTimeout(800)
const viewport = await canvas.evaluate(() => document.body.innerText.match(/\d+px · \d+%/)?.[0] ?? '')
console.log('手机视口 =', viewport)
await canvas.screenshot({ path: `${process.env.TEMP}\\duplex-canvas-mobile.png` })

if (dataDir) {
  const root = path.join(dataDir, '.cobrowse', 'designs')
  if (existsSync(root)) {
    const project = path.join(root, 'design-1')
    const rounds = path.join(project, 'rounds.log')
    if (existsSync(rounds)) {
      console.log('rounds.log 最后 3 行 =', readFileSync(rounds, 'utf8').trim().split('\n').slice(-3))
    }
    console.log('design.json 存在 =', existsSync(path.join(project, 'design.json')))
    console.log('site/.git 存在 =', existsSync(path.join(project, '.git')))
  } else {
    console.log('没找到 designs 目录：', root)
  }
}
await browser.close()
