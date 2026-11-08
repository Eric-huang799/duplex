// 本地探针页服务：只用于自动化特征实测（A/B 对比 CDP 与进程内输入）。
// 用法：node tools/probe-server.mjs [port]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const page = path.join(here, 'detection-harness.html')
const port = Number(process.argv[2] ?? 8799)

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url?.startsWith('/?')) {
    fs.readFile(page, 'utf8', (error, html) => {
      if (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('无法读取探针页：' + error.message)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    })
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`probe page: http://127.0.0.1:${port}/`)
})
