# Duplex visual directions

- **Chosen**: light = C · Sand Studio (warm cards) cooled with B · Quiet Graphite neutrals; dark = B · Quiet Graphite.
- Boards: `concepts.html` (3 light + 3 dark), PNGs in this folder.
- Implementation: renderer `src/renderer/src/styles.css` tokens + canvas `src/canvas/styles.css` tokens.
- Start page illustration assets (`start-bg.jpg` / `start-bg-dark.jpg`) unchanged; only gradient/overlay tokens follow the theme.
- Typography: Apple-first stack (`SF Pro Text` before `Segoe UI`).
- Verified: docs/screenshots/theme-light.png and theme-dark.png; real window capture in dark mode confirms nativeTheme applies (Playwright CDP otherwise emulates light).
