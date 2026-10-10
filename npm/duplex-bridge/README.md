# duplex-bridge

stdio MCP bridge for **[Duplex](https://github.com/Eric-huang799/duplex)** — a browser shared by a human and an AI. It exposes 24 browser tools (navigate, click, type, snapshot, screenshot, annotations, …) over the Model Context Protocol and forwards them to the Duplex app running on your machine.

## Requirements

- **Duplex installed** — download the latest release: https://github.com/Eric-huang799/duplex/releases
  (The bridge auto-launches the installed app on the first tool call.)

## Use it in any MCP client

```jsonc
{
  "mcpServers": {
    "duplex": {
      "command": "npx",
      "args": ["-y", "duplex-bridge"]
    }
  }
}
```

opencode (`opencode.json`):

```json
{
  "mcp": {
    "duplex": {
      "type": "local",
      "command": ["npx", "-y", "duplex-bridge"],
      "enabled": true
    }
  }
}
```

Claude Code:

```bash
claude mcp add duplex -- npx -y duplex-bridge
```

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.duplex]
command = "npx"
args = ["-y", "duplex-bridge"]
```

## How it works

- stdout carries JSON-RPC (stdio MCP); all logs go to stderr.
- Tool listing is static, so MCP startup needs no browser.
- On the first tool call the bridge finds a running Duplex instance via `~/.cobrowse/endpoint.json` (or launches the installed app) and proxies every call to its local HTTP endpoint.
- Dev checkouts: if `COBROWSE_ROOT` points at a Duplex project root, the bridge uses the dev build instead of the installed app.

## License

MIT — see [LICENSE](https://github.com/Eric-huang799/duplex/blob/master/LICENSE).
