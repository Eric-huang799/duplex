# 设计：长会话上下文压缩（替代"截断丢信息"）

> 现状：`src/main/agent/runtime.ts` 在历史超限时用 `truncateWithMarker` 截断，并插入一条
> `sys-history-truncated` 系统提示。信息是真丢了——之后的回答可能出现"你刚才说的那个"对不上。

## 一、目标

1. 长会话（>60 轮或 >模型上下文 70%）时**保留要点**而不是丢弃；
2. 压缩过程可解释：用户能看到"把前 40 轮压缩成 6 条要点"；
3. 与 TriState-KV 研究叙事对齐：压缩策略可插拔、可度量。

## 二、方案（分三步，前两步不依赖新存储）

### 第 1 步：摘要压缩（0.3.x）

- 触发：消息 token 估算超过阈值（默认 60%）且轮次 ≥ 20。
- 做法：把**最老的 N 条**（保留最近 6 轮原文）交给一次独立的模型调用：
  `请把下面这段浏览器操作历史压缩成要点，保留：用户目标、已完成的动作、失败与原因、待确认事项、站点与关键值`。
- 结果替换为一条 `role: 'assistant'` 的摘要消息 + 原文存入 `archived` 数组（**不删除**，只在上下文里折叠），用户可在面板里展开"已折叠的 40 轮"。
- 失败回退：摘要调用失败 → 退化为现有截断，并在提示里说明"压缩失败，已截断"。

### 第 2 步：结构化折叠（0.3.x 末）

- 工具调用的参数/结果天然是结构化的：对已完成的工具调用，只保留 `tool + 关键参数 + 一行结果摘要`，原始 HTML/snapshot 文本折叠。
- 这一条收益最大：浏览器 agent 的上下文里 80% 体积是 snapshot/HTML 原文。

### 第 3 步：与 TriState-KV 对齐（研究线）

- 把"保留哪些事实"做成策略接口 `CompactionPolicy`，先用启发式（目标/失败/待确认），再替换为 KV 检索补充。
- 度量：压缩前后在**同一组回放问题**上的正确率（可离线跑，不需要真实用户）。

## 三、接口草案

```ts
export interface CompactionInput {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  keepRecent: number
  thresholdRatio: number
}
export interface CompactionResult {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  /** 被折叠的原文，供 UI 展开 */
  archived: Array<{ at: number; text: string }>
  /** 压缩说明（展示给用户的一句话） */
  note: string
  mode: 'summary' | 'truncated'
}
export type Summarize = (prompt: string, text: string) => Promise<string>
export function planCompaction(input: CompactionInput): { toSummarize: string[]; recent: number[] }
```

`planCompaction` 是纯函数（可单测），摘要调用在主进程完成并注入。

## 四、验收

- 构造 80 轮含失败与待确认项的会话：压缩后提问"我们之前卡在哪一步"，回答仍正确。
- 压缩失败的路径：注入一个总是抛错的 `Summarize`，断言退化为截断且提示文案正确。
- 体积：同一会话压缩后 token 数下降 ≥ 60%，最近 6 轮原文完整。

## 五、为什么现在不做完

压缩会改动 agent 的消息组装路径，属于"一改就可能让所有会话行为变化"的模块；
0.3.0 的优先级是浏览器基本功（更新/权限/打印/拼写）与输入路径去 CDP。
本文件把方向与验收钉住，0.3.x 直接按此实施。
