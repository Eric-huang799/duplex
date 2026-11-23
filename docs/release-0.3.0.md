# Duplex 0.3.0（正式版）

0.3.0 是 Duplex 第一个正式版。核心变化不是又加了一个功能，而是把"可扩展"做成了结构。

## 设计画布：独立插件，推荐安装

- 设计画布现在是**功能插件**，不再是浏览器内建的硬编码入口
- 默认安装并启用，设置页标记为「推荐」；可在 **设置 → 功能插件** 禁用/启用，禁用只隐藏入口，不删除数据
- 通用插件宿主：manifest + `index.mjs`，外部插件目录 `<cobrowseDir>/features/<id>/`，支持安装、启停、命令/工具/状态卡
- 接口与限制见 `docs/handoff/2026-11-20-design-canvas.md`

## 视觉

- 白天：Sand Studio 的暖卡片 + Quiet Graphite 的冷灰中性；夜间：Quiet Graphite
- 全局生效（地址栏、搜索、设置、AI 面板、画布），启动页插图保持不变
- 关键动作引入橙色反差色（发送、模式选中、生成进度、功能按钮），只做小面积强调

## 其他

- 本地资产库：内容寻址、剪贴板/文件夹导入、画布图片、导出自动打包 `site/assets`
- 多 agent 会话与授权、会话级"一键放行"、急停/恢复的可见性修复
- 新用户评审后的一批可用性修复（空态示例、生成进度、工具卡人话标题、导出结果卡等）

## 安装与验证

```bash
npm install
npm run typecheck
npx vitest run
npm run build
```

测试：826 passed / 5 skipped（78 文件）；typecheck 与 build 通过。

## 已知限制

- 外部插件在主进程执行，**没有沙箱**；只安装可信来源
- 插件卸载/升级/签名/市场尚未实现
- 设计插件禁用时，外部 MCP bridge 的静态工具列表仍可能列出 `design_*`（调用会失败）

## Windows 安装包（0.3.0）

- **Duplex-Setup-0.3.0.exe** — NSIS x64，112.00 MB，可直接覆盖安装旧版本
- **SHA256**: `F839FD0F218528290C1A6CB687CE79BE30C194FEC1D0B4A49D95E36E38B5EB08`
- 未做代码签名：Windows SmartScreen 可能提示"未知发布者"，选择"仍要运行"即可
- 自动更新元数据：`latest.yml`、`Duplex-Setup-0.3.0.exe.blockmap`
- 源码包仍在本 Release 附件中
