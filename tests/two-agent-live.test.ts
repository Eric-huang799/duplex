/**
 * 双 agent 真实验：两个**独立的大模型循环**在同一个标签上协作。
 *
 * 与 arbiter-experiment 的区别：那边的两个"agent"是脚本，这里每个 agent 都有自己的
 * 模型调用、自己的观察-决策循环，因此能量出真实代价（模型延迟、重复动作、等待占比）。
 *
 * 运行前提：应用已启动（本测试通过 CDP 连上去，不自己启动窗口），探针页在 8799。
 *   $env:DUPLEX_LIVE_DUAL_AGENT = '1'
 *   npx vitest run tests/two-agent-live.test.ts
 */
import { describe, expect, it } from 'vitest'
import { chromium, type Page } from 'playwright-core'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MultiAgentArbiter } from '../src/main/multi-agent-arbiter'

const PROBE = 'http://127.0.0.1:8799/'
const enabled = process.env.DUPLEX_LIVE_DUAL_AGENT === '1'
const dataDir = process.env.DUPLEX_DATA_DIR ?? path.join(process.env.TEMP ?? '.', 'duplex-030')

interface Provider {
  baseUrl: string
  apiKey: string
  model: string
}

function devtoolsPort(): number {
  const file = path.join(dataDir, 'electron', 'DevToolsActivePort')
  if (!existsSync(file)) throw new Error(`没有找到 ${file}：应用没启动或没开调试端口`)
  return Number(readFileSync(file, 'utf8').split(/\r?\n/)[0])
}

function provider(): Provider {
  const file = path.join(dataDir, 'settings.json')
  if (!existsSync(file)) throw new Error(`没有 ${file}`)
  const settings = JSON.parse(readFileSync(file, 'utf8')) as {
    // 应用把模型配置存在 agentProviders（不是 providers）
    agentProviders?: Array<{ id?: string; baseUrl?: string; apiKey?: string; model?: string }>
    activeProviderId?: string
  }
  const list = settings.agentProviders ?? []
  const withKey = list.filter((entry) => entry.apiKey && entry.model)
  const active =
    withKey.find((entry) => entry.id === settings.activeProviderId) ?? withKey[0]
  if (!active?.apiKey || !active.model) {
    throw new Error('settings.json 的 agentProviders 里没有可用 provider（缺 apiKey/model）')
  }
  return {
    baseUrl: active.baseUrl ?? 'https://api.deepseek.com',
    apiKey: active.apiKey,
    model: active.model
  }
}

const TARGETS: Record<string, string> = {
  按钮: '#probe-btn',
  输入框: '#probe-input'
}

interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'click',
      description: '点击页面上的按钮。target 只能是：按钮',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', enum: ['按钮'] } },
        required: ['target']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'type',
      description: '在页面输入框中输入文本（会替换原有内容）。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read',
      description: '读回页面当前状态：按钮被点击的次数、输入框内容。',
      parameters: { type: 'object', properties: {} }
    }
  }
]

async function chat(
  cfg: Provider,
  messages: unknown[],
  signal: AbortSignal
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const response = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, tools: TOOLS, temperature: 0 }),
    signal
  })
  if (!response.ok) throw new Error(`模型返回 ${response.status}：${(await response.text()).slice(0, 200)}`)
  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
      }
    }>
  }
  const message = data.choices?.[0]?.message
  const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    args: ((): Record<string, unknown> => {
      try {
        return JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
      } catch {
        return {}
      }
    })()
  }))
  return { content: message?.content ?? '', toolCalls }
}

interface Metrics {
  actor: string
  modelCalls: number
  toolCalls: number
  clicks: number
  waits: number[]
  errors: string[]
}

/** 一次真实点击：先拿坐标，再交给浏览器派发（走 Playwright 的 CDP 输入，测量路径）。 */
async function realClick(page: Page, selector: string): Promise<void> {
  const point = (await page.evaluate((sel: string) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  }, selector)) as { x: number; y: number } | null
  if (!point) throw new Error(`找不到 ${selector}`)
  await page.mouse.click(point.x, point.y)
}

async function realType(page: Page, text: string): Promise<void> {
  await page.click('#probe-input')
  await page.fill('#probe-input', '')
  await page.type('#probe-input', text)
}

async function runAgent(
  actor: string,
  instruction: string,
  cfg: Provider,
  page: Page,
  arbiter: MultiAgentArbiter,
  budget: number
): Promise<Metrics> {
  const metrics: Metrics = { actor, modelCalls: 0, toolCalls: 0, clicks: 0, waits: [], errors: [] }
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: '你是一个浏览器 agent。只用提供的工具完成任务，不要多也不要少。' },
    { role: 'user', content: instruction }
  ]
  const controller = new AbortController()
  for (let step = 0; step < budget; step++) {
    let reply: { content: string; toolCalls: ToolCall[] }
    const started = Date.now()
    try {
      reply = await chat(cfg, messages, controller.signal)
    } catch (error) {
      metrics.errors.push(`模型调用失败：${(error as Error).message}`)
      break
    }
    metrics.modelCalls++
    const modelMs = Date.now() - started
    metrics.waits.push(modelMs)
    messages.push({
      role: 'assistant',
      content: reply.content || null,
      tool_calls: reply.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) }
      }))
    })
    if (reply.toolCalls.length === 0) break

    for (const call of reply.toolCalls) {
      metrics.toolCalls++
      try {
        if (call.name === 'click') {
          const selector = TARGETS[String(call.args['target'] ?? '')] ?? TARGETS['按钮']
          await arbiter.withTarget(actor, 1, selector, async () => {
            await realClick(page, selector)
            metrics.clicks++
            await new Promise((resolve) => setTimeout(resolve, 60))
          })
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'clicked' })
        } else if (call.name === 'type') {
          const text = String(call.args['text'] ?? '')
          await arbiter.withTarget(actor, 1, '#probe-input', async () => {
            await realType(page, text)
            await new Promise((resolve) => setTimeout(resolve, 60))
          })
          messages.push({ role: 'tool', tool_call_id: call.id, content: `typed: ${text}` })
        } else {
          const state = (await page.evaluate(() => ({
            clicks: (window as unknown as { __CLICKS__?: { count: number } }).__CLICKS__?.count ?? -1,
            input: (document.querySelector('#probe-input') as HTMLInputElement | null)?.value ?? ''
          }))) as { clicks: number; input: string }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(state) })
        }
      } catch (error) {
        metrics.errors.push(`${call.name} 失败：${(error as Error).message}`)
        messages.push({ role: 'tool', tool_call_id: call.id, content: `error: ${(error as Error).message}` })
      }
    }
  }
  return metrics
}

describe.skipIf(!enabled)('双 agent 真模型共用同一标签', () => {
  it('两个独立模型循环协作：各点两次按钮 + 一方输入文本', async () => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${devtoolsPort()}`)
    const pages: Page[] = []
    for (const context of browser.contexts()) pages.push(...context.pages())
    const page = pages.find((candidate) => !candidate.url().startsWith('file:'))
    if (!page) throw new Error('没有可用的网页标签：请先在应用里打开探针页')

    await page.goto(PROBE)
    await page.evaluate(() => {
      const w = window as unknown as { __CLICKS__?: { count: number } }
      if (w.__CLICKS__) w.__CLICKS__.count = 0
    })

    const cfg = provider()
    const arbiter = new MultiAgentArbiter({ navTimeoutMs: 5000 })
    const [agentA, agentB] = await Promise.all([
      runAgent(
        'agent-1',
        '请点击"按钮"两次，不要做别的事。第一次点击后先 read 一次确认，然后再点第二次。',
        cfg,
        page,
        arbiter,
        6
      ),
      runAgent(
        'agent-2',
        '请在"输入框"里输入文本 duplex，然后 read 一次确认输入框内容，不要点击按钮。',
        cfg,
        page,
        arbiter,
        6
      )
    ])

    const final = (await page.evaluate(() => ({
      clicks: (window as unknown as { __CLICKS__?: { count: number } }).__CLICKS__?.count ?? -1,
      input: (document.querySelector('#probe-input') as HTMLInputElement | null)?.value ?? ''
    }))) as { clicks: number; input: string }

    const report = {
      agents: [agentA, agentB].map((m) => ({
        actor: m.actor,
        modelCalls: m.modelCalls,
        toolCalls: m.toolCalls,
        clicks: m.clicks,
        modelMsTotal: m.waits.reduce((a, b) => a + b, 0),
        errors: m.errors
      })),
      final,
      plannedClicks: 2,
      clickAccuracy: final.clicks === 2 ? 'exact' : final.clicks > 2 ? 'duplicated' : 'missing',
      inputCorrect: final.input === 'duplex'
    }
    console.log('[dual-agent] report:', JSON.stringify(report, null, 2))
    await browser.close()

    // 真模型有随机性：这里只断言"没有重复点击"和"输入最终正确"，不断言过程步数
    expect(report.clickAccuracy).not.toBe('duplicated')
    expect(report.inputCorrect).toBe(true)
  }, 240_000)
})
