import { chromium } from 'playwright-core'
const b = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2]}`)
const pages = []
for (const c of b.contexts()) for (const p of c.pages()) pages.push(p)
const ui = pages.find((p) => p.url().startsWith('file:') && p.url().includes('index.html'))
await ui.screenshot({ path: `${process.env.TEMP}\\duplex-stuck.png` })
const text = await ui.evaluate(() => document.body.innerText.slice(0, 1200))
console.log(JSON.stringify({ pages: pages.map((p) => p.url()), text }, null, 2))
await b.close()
