# Duplex 0.2.5 — Browser-first desktop experience

## Goal

Develop Duplex 0.2.5 in an isolated worktree. Keep the existing 0.2.1 checkout, install, user data, and release assets unchanged. Make ordinary browsing the default experience, restore reliable file downloads, and keep browser control in OpenCode explicitly user-selected.

## Product behavior

### Browser-first window

- Keep the familiar tab strip, navigation controls, and one address/search field.
- Make the browser content area the primary view. Start with the AI side panel collapsed; remember the user's choice and provide a clear control to open it.
- Move search-engine selection into the address field's menu. Keep annotation and emergency-stop settings reachable from a compact tools menu.
- Use one coherent icon set, spacing scale, and interaction states for light, dark, and system themes. Favor clear, calm browser chrome over the current translucent tool-panel appearance.
- Make the new-tab page a practical browser start page: search, bookmarks, and recent pages, while retaining Duplex's visual identity as a restrained background treatment.
- Give the existing light/dark new-tab illustrations gentle independent drift, depth blur, and a slow light sweep using CSS; animate content entrance and hover states, and honor `prefers-reduced-motion`. Keep the source art unchanged and add no video/image dependency.

### Everyday browsing

- Add bookmark/unbookmark from the address bar, plus a simple searchable bookmark list.
- Add a searchable browsing-history view, with per-entry removal and clear-history action.
- Add familiar keyboard shortcuts: focus address bar, new/close tab, next/previous tab, reload, reopen last closed tab, find in page, and bookmark current page.
- Add favicon display and a small tab context menu for common tab actions. Do not add tab groups, extensions, password storage, or site-permission controls in this release.

### Downloads

- Listen for downloads from the existing persistent browser session and save them to the operating system Downloads folder by default.
- Show active progress and completed/interrupted results in a download panel. Support cancel for active items, open completed files, and reveal their folder.
- Clearing the download list removes its records only; it never deletes downloaded files.
- Persist completed/interrupted metadata locally. An active download that is not recoverable after restart is shown as interrupted.

### Local browser data

- Keep bookmarks, history, and download records in a separate local browser-data file under Duplex's existing data directory; do not add them to `settings.json`, which also stores provider credentials.
- Record top-level HTTP(S) navigations, not internal start pages or subframe requests. Retain at most 5,000 history entries and 500 download records, trimming the oldest records first.
- No sync, account service, or external telemetry is introduced.

## OpenCode opt-in

The installed OpenCode Desktop is 1.18.33. Its composer exposes server-listed custom commands in the slash picker; this release must verify command invocation and agent routing against that installed version.

- Ordinary OpenCode conversations must not have permission to execute Duplex MCP tools.
- Add a dedicated `duplex` agent with access to the Duplex MCP tool namespace; ordinary agents receive an explicit deny for that namespace.
- `/duplex <task>` runs one browser task through a child/subtask agent so the user's normal agent remains selected afterward.
- `/duplex-task <goal>` selects the Duplex agent for a multi-turn task. `/duplex-stop` selects the configured ordinary default agent again. The current session shows a visible Duplex-active state through the agent selection.
- Do not replace or reset the user's configured default agent. Read the existing default-agent name when preparing `/duplex-stop`; if none is configured, use OpenCode's standard `build` agent.
- Preserve unrelated OpenCode config and create a timestamped backup before updating global settings. Make the integration setup reversible and explain which files it adds or updates.
- If the installed Desktop build cannot list/execute the commands or keep agent selection as specified, do not silently fall back to model instructions. Keep the tools denied in ordinary mode and expose the supported agent-selection path in Duplex's integration settings.

## Architecture direction

- Reuse the existing Electron `WebContentsView` tabs and persistent session. Add focused modules for browser data storage and download lifecycle rather than expanding `src/main/index.ts` further.
- Add explicit IPC/preload APIs for bookmarks, history, downloads, and browser UI preferences; renderer components must not access filesystem paths directly.
- Keep persistence logic independently testable and bound the data retained.
- Record history from main-frame navigation events. Handle `will-download` on the same Electron session used by browser tabs, retaining progress state while downloads run.
- Keep the OpenCode mirror/injection behavior separate from opt-in tool permissions; normal OpenCode text mirroring continues to work when browser tools are denied.

## Acceptance criteria

1. Existing checkout and installed 0.2.1 application are untouched; all source changes live on `codex/v0.2.5` at `CoBrowse-0.2.5`.
2. A normal OpenCode request does not invoke or launch Duplex browser tools; `/duplex` and `/duplex-task` are visible and execute in the installed Desktop build, and `/duplex-stop` returns to the user's configured ordinary agent.
3. A user can navigate, bookmark, find prior pages, switch/manage tabs, use common browser shortcuts, and open a conventional new tab without opening the AI panel.
4. HTTP(S) files with `Content-Disposition: attachment` download to the Downloads folder and appear with progress/result actions; ordinary page navigation remains unaffected.
5. Light/dark/system themes retain readable contrast and consistent control states. Browser controls remain usable at narrower window widths.
6. No existing OpenCode keys, Duplex provider credentials, or signing materials enter the repository, logs, or screenshots.

## Scope boundaries and risks

- No publishing, tagging, or editing the existing release. The branch may set package metadata to 0.2.5, but release publication remains a separate user decision.
- The primary compatibility risk is OpenCode Desktop command and agent behavior, especially task-mode return to the user's prior default. Validate with the installed 1.18.33 app before claiming support.
- Electron downloads must be checked for interrupted/network-failure cases and duplicate filenames on Windows, macOS, and Linux.
- The release remains a browser with AI assistance, not a full Chrome replacement: no extension system, sync, password manager, or account profiles.
