# OpenCode 中显式使用 Duplex

Duplex 浏览器工具通过 MCP 暴露，但普通 OpenCode agent 应默认拒绝这些工具。用户在输入框里选择 `/duplex` 才为这一条任务启用浏览器；选择 `/duplex-task` 后持续使用 Duplex，直到 `/duplex-stop`。

## 安装到项目

将仓库里的 `.opencode/agents/duplex.md` 和 `.opencode/commands/` 放入 OpenCode 项目的同名目录，并在该项目的 `opencode.json` 中合并 MCP 服务配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": { "duplex_*": "deny", "*": "allow" },
  "mcp": {
    "duplex": {
      "type": "local",
      "command": ["node", "C:/path/to/Duplex/dist-bridge/index.cjs"],
      "cwd": "C:/path/to/Duplex",
      "enabled": true,
      "timeout": 20000
    }
  }
}
```

保留现有配置的其他字段。给 `duplex` agent 单独开放 `duplex_*` 工具；普通 agent 通过项目配置拒绝该命名空间。镜像插件仍独立运行，不会自动获得浏览器工具权限。

## 返回你原来的 agent

`/duplex-stop` 示例默认回到 OpenCode 的 `build` agent。如果你平时使用的普通 agent 名字不同，把该命令文件 frontmatter 的 `agent: build` 换成那个名字。命令只切换当前对话的 agent，不改 OpenCode 的默认 agent。

采用项目配置时，移除上述三个命令、agent 文件和 `opencode.json` 内 `duplex` MCP/permission 项即可撤销。若要写入全局配置，先备份原配置并保留时间戳副本，再合并而不是覆盖；不要把 provider key 或 Duplex `settings.json` 放进项目。

桌面端命令选择由已安装 OpenCode 版本决定。本仓库提供命令与权限文件，不会自动修改用户的全局 OpenCode 配置。
