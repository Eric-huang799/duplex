# 起始页素材

## 当前状态

- `start-bg.jpg` —— **亮色模式背景**（白天插画，1672×941，约 196 KB）
- `start-bg-dark.jpg` —— **暗色模式背景**（夜景插画，1672×941，约 258 KB）
- 切换方式：`<picture>` + `(prefers-color-scheme: dark)` 媒体查询，**随主题自动切换**（含"跟随系统"时系统主题变化）
- 显示效果：顶部清晰 → 向下渐进模糊（CSS 双层实现，见 `src/renderer/src/styles.css` 的 `.start-bg-sharp` / `.start-bg-blur`）

## 替换素材

放入同目录（`src/renderer/public/`），文件名固定，无需改代码：

| 模式 | 文件名 |
|---|---|
| 亮色模式背景 | `start-bg.jpg` |
| 暗色模式背景 | `start-bg-dark.jpg` |

- 开发模式（npm run dev）即时生效；打包模式需重新 `npm run build`
- 规格建议：1920×1080 或 2560×1440 横版、< 800 KB、中央区域避免高对比主体（时钟/搜索框在正中）
- 只放一张也可以：亮色缺图时该模式回退为深色/浅色渐变，不会报错

## 效果微调

`src/renderer/src/styles.css`：

| 想要的效果 | 调什么 |
|---|---|
| 图片整体更亮/更暗 | `.start-bg-sharp` 的 `opacity`（暗色/亮色模式在文件里各有覆盖块） |
| 模糊程度 | `.start-bg-blur` 的 `blur(26px)` |
| 清晰→模糊的过渡位置 | 两个 mask-image 的渐变色标（当前约为 1/3 处开始过渡） |
| 底部暗度/亮度 | `.start-glow` 的渐变透明度（用 `--start-glow` RGB 变量组合） |
