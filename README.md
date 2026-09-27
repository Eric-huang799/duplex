# Duplex

<p align="center"><img src="docs/screenshots/mascot.png" width="360" alt="Duplex mascot"></p>

**One browser shared by a human and an AI** — the human sees the rendered page, the AI reads the DOM and page source. Same tabs, same live session, at the same time.

**English** | [中文](README.zh-CN.md)

![Duplex start page, dark theme](docs/screenshots/start-page-dark.png)

*Duplex start page (dark theme). A [light theme](docs/screenshots/start-page-light.png) is also included.*

## Demo

### Act 1: Searching Bilibili and playing a paper-explainer video

[![Click to play the demo](docs/screenshots/demo-video-cover.jpg)](docs/videos/act1-bilibili-demo.mp4)

*The built-in agent does it all on its own: switch model → type the instruction → search Bilibili → pick and play a video. This is a silent preview — a narrated version is in the works.*

![Controlling Excel for the web with Duplex](docs/screenshots/excel-web-demo.png)

*Controlling Microsoft Excel for the web — no dedicated spreadsheet-editing skill installed; only the stock API and a few simple automation skills* 😅

> **A feasibility demo, not a recommended workflow.** With no task-specific skill to lean on, Duplex worked with the stock API plus a few simple automation skills alone — improvising clipboard read/write channels, DOM probing and the like to push a whole grade sheet into Excel for the web. It got there, but the process wasted a lot of time and tokens. 😅

## ⚠️ Usage notes

- **Security boundaries (high stakes — please read).** Duplex lets the AI drive your **real browser session**, including login state, cookies and local data. Under this architecture, a wrong AI move can touch real accounts and data (sending messages, submitting forms, modifying or deleting content), potentially with serious consequences. Don't leave the agent running unattended in environments where sensitive accounts are signed in. `Esc` takeover is a last-resort human brake — it is **no substitute for your own judgement about what the AI should be allowed to touch**.

- **The tooling layer is still being tuned.** The goal is for **the human to stay in command of the AI's tools**, rather than have AI tooling and the human's own actions crowd each other out of the pipeline (contending for the same page, interrupting input, interleaving conflicting actions). The trade-offs here are still evolving — feedback on human/agent contention is welcome via Issues.

## Highlights

- **A real browser** — tabs, address bar with search (Baidu / Bing / Google), back / forward / reload, loading state, themes (light / dark / follow system) and a wallpaper start page with a clock and search.
- **24 MCP tools for AI agents** — `snapshot` compresses any page into a compact DOM outline with `[eN]` refs; the other tools cover tabs, navigation, clicking, typing, dragging, file upload, scrolling, waiting, console logs, JS evaluation and page annotations.
- **Zero-setup bridge** — a stdio MCP bridge (`mcp-bridge`) auto-launches the browser on the first tool call. Works with opencode, Claude Code, or any MCP client.
- **Live session mirror** — when your AI works through opencode, its replies, reasoning and tool-call cards stream into the side panel in real time. Type in the panel to inject a message into the *same* session.
- **AI action visualization** — a translucent cursor, element highlight and a status bar ("AI is clicking «…» — Esc to take over") are drawn in a Shadow-DOM overlay, so you always see what the AI is doing on the page.
- **Esc takeover** — press `Esc` (or click the status bar) to take control instantly: the running tool call is aborted, in-flight waits return early, and the AI is told the user took over.
- **Page annotations** — press `?` or use `annotation_mode` to draw a box / circle / arrow / point on any page and attach a question. The annotation is compiled into a structured text brief (DOM outline + visible text + selectors + geometry) and sent to the AI.
- **Built-in agent (optional)** — connect any OpenAI-compatible API (DeepSeek, Kimi, Qwen, GLM, Ollama, …) and let the browser drive itself. Provider management supports one-click import from opencode.
- **Conversation history** — built-in agent sessions are saved locally and can be reopened from the history menu.

## Feature tour

### 1. Start page

![Dark start page](docs/screenshots/start-page-dark.png)

The start page shows a clock, date and search box over a wallpaper that follows the active theme (light and dark wallpapers switch automatically with the system).

### 2. Built-in agent drives the browser

![Built-in agent in action](docs/screenshots/agent-mode.png)

Ask the built-in model in the side panel — in Chinese or English. It calls tools (`navigate`, `snapshot`, …), with each call shown as a card, and reports back in the panel while you watch the page change.

### 3. opencode session mirror

![opencode session mirror](docs/screenshots/mirror-panel.png)

When your AI runs through opencode, its messages and tool calls are mirrored into the panel while it drives the same visible browser. The "opencode" / "built-in" tabs at the top of the panel switch between the two ways of working.

### 4. Session picker

![Session picker](docs/screenshots/session-picker.png)

Pick which opencode session the panel is connected to. "Auto" follows the most recent conversation.

### 5. Model providers

![Model providers](docs/screenshots/providers-panel.png)

Manage OpenAI-compatible providers for the built-in agent: add, edit, delete, or import providers directly from your opencode configuration. Local models via Ollama (`http://localhost:11434/v1`) work out of the box.

### 6. Conversation history

![Conversation history](docs/screenshots/agent-history.png)

Built-in agent conversations are stored locally and can be reopened at any time.

### 7. AI action visualization and Esc takeover

![AI action visualization](docs/screenshots/ai-action-visualization.png)

Every AI action is drawn on the page: a cursor ring, an element highlight and a status bar. Press `Esc` at any moment to take the browser back — the AI stops immediately and waits for your instruction.

### 8. Page annotations

![Page annotations](docs/screenshots/annotation-tools.png)

Draw a box (or circle / arrow / point) around anything and ask a question about it. The annotation is converted into a structured text brief for the AI, including the DOM outline of the region, visible text, selectors and geometry — so even text-only AIs can "see" what you mean.

## Quick start

### Installer (Windows)

1. Download `Duplex Setup 0.1.0.exe` from [Releases](../../releases).
2. Run the installer and launch Duplex.

### Build from source

```bash
npm install
npm run build          # Electron app -> out/
npm run build:bridge   # stdio MCP bridge -> dist-bridge/index.cjs
```

> If Electron's binary download fails (e.g. behind a slow mirror), retry with:
> `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js`

Run it:

```bash
npm run dev    # development mode with HMR
# or
npm start      # preview the production build
```

### Connect opencode (recommended)

1. Install the mirror plugin. Copy `integrations/opencode/plugins/cobrowse-mirror.ts` to your global opencode plugin directory (`~/.config/opencode/plugins/`), or into `.opencode/plugins/` of a project.
2. Register the MCP server in your opencode config (`opencode.json`), project-level or global — see [`opencode.example.json`](opencode.example.json):

```json
{
  "mcp": {
    "duplex": {
      "type": "local",
      "command": ["node", "C:\\path\\to\\Duplex\\dist-bridge\\index.cjs"],
      "enabled": true
    }
  }
}
```

3. In opencode, ask the AI to browse: *"open example.com and describe the page"*. The browser launches automatically on the first tool call (no need to start it manually).
4. In the Duplex side panel choose the **opencode** tab and select the session you want to follow (or keep "Auto").

### Use the built-in model (no opencode required)

Panel → **Built-in** tab → **Model settings** → add an OpenAI-compatible provider (base URL, API key, model name), or click **Import from opencode** to reuse your existing provider configuration. For local models, point the base URL to Ollama, e.g. `http://localhost:11434/v1`.

## MCP tools

| Tool | Description |
|---|---|
| `list_tabs` / `new_tab` / `close_tab` / `switch_tab` | Tab management — human and AI share the same tabs |
| `navigate` / `search` / `history` | Open a URL (auto-searches if not a URL), search (Baidu default, or Bing / Google), back / forward / reload |
| `snapshot` | **Page as text** — compact DOM outline; interactive elements carry `[eN]` refs |
| `get_html` / `query` | Raw HTML, or detailed info for elements matching a CSS selector |
| `screenshot` | PNG screenshot of the visible page (for multimodal models) |
| `click` / `dblclick` / `hover` | Click / double-click / hover; `target` accepts an `eN` ref or a CSS selector |
| `type` / `press` | Type text (optionally submitting) and press keys, incl. combos like `Control+A` |
| `drag` | Real drag & drop from one point/element to another |
| `select_option` / `upload` | Native `<select>` options, and file upload by absolute path |
| `scroll` | Scroll the page or a specific element into view |
| `wait` | Wait for time / selector / text — interruptible by Esc |
| `get_console` | Read page console logs (errors and warnings) |
| `annotation_mode` | Enter/exit the annotation overlay (human draws a box/circle/arrow/point + question) |
| `evaluate` | Evaluate JS in the page, returns JSON-serializable results |

## How it works

![Architecture](docs/screenshots/architecture.jpg)

- The Electron main process serves a small local HTTP API on `127.0.0.1` protected by a per-launch bearer token (endpoint info is written to `~/.cobrowse/endpoint.json`).
- `dist-bridge/index.cjs` is a stdio MCP server that proxies tool calls to that API and auto-launches the app when it is not running.
- The opencode plugin pushes session events (text, reasoning, tool calls) into the panel, and long-polls for messages queued in the browser (~10 ms injection latency).
- Panel messages and page annotations are injected into the active opencode session with `session.promptAsync`.
- External scripts can also push messages into the session: `POST /api/chat { "text": "..." }`.

## Known limitations

- Page internals inside iframes and shadow DOM are not covered by `snapshot` / `click` — shadow DOM is only detected, not entered.
- `eN` refs are invalidated by navigation; re-run `snapshot` after the page changes.
- Message injection targets the "active session"; with several opencode sessions the target may occasionally be ambiguous.
- The mirror store holds the recent event stream in memory; it resets on browser restart.
- The built-in agent is a convenience option: local / smaller models are noticeably less reliable at long tool-use chains than a full opencode setup.

## Roadmap

- **Codex / Claude Code compatibility (next up)** — more first-class AI client integrations:
  - The bridge is client-agnostic (standard stdio MCP), so the *tool layer* is not opencode-specific by design.
  - Planned: official adapters and **session mirroring** for **Codex**, **Claude Code** and other AI clients, so their conversations appear in the side panel the same way opencode's do.

## Development

```bash
npm run dev        # dev mode (electron-vite, HMR for the renderer)
npm run typecheck  # TypeScript checks (node + web)
npm test           # unit tests (vitest)
npm run smoke      # end-to-end smoke test (launches the bridge and a real browser)
npm run dist       # build the Windows installer (electron-builder)
```

Debug helpers:

- `GET /api/debug/ui-snapshot` — captures the current window to `~/.cobrowse/ui-snapshot.png`.
- `POST /api/debug/panel-eval` — runs JS in the panel renderer (only when the app is started with `COBROWSE_DEBUG_UI=1`).
- Logs: `~/.cobrowse/app.log` (main + renderer log lines).

## License

[MIT](LICENSE)
