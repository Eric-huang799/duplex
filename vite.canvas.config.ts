/**
 * 设计画布的独立构建。
 *
 * 为什么单独一个 Vite 配置，而不是塞进 electron-vite 的 renderer：
 *  - 画布是**不依赖 React** 的原生 TS 页面，和主 UI 的技术栈不同；
 *  - 它要作为 `file://` 页面被 WebContentsView 直接加载，资源必须相对路径；
 *  - 独立构建不会影响主 renderer 的入口与产物路径（out/renderer/index.html）。
 */
import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  root: path.resolve(__dirname, 'src/canvas'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'out/canvas'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/canvas/index.html')
    }
  },
  server: { port: 5178, strictPort: true }
})
