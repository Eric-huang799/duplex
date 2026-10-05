---
description: 将当前任务切换到 Duplex 浏览器 agent，直到用户使用 /duplex-stop
agent: duplex
---

用户已明确开启持续 Duplex 模式。接下来的多轮任务优先使用 Duplex 浏览器，当前目标：$ARGUMENTS
持续保持本 agent，直到用户明确调用 /duplex-stop；不要仅因一次浏览结束就自行切回。
