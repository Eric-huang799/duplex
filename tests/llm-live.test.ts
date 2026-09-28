/**
 * Live LLM smoke test — only runs when LLM_LIVE=1 is set.
 * Uses the real provider config from ~/.cobrowse/settings.json (small call).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chatStream } from '../src/main/agent/llm'

const live = !!process.env.LLM_LIVE

function pick(name: string): { baseUrl: string; apiKey: string; model: string } | null {
  try {
    const d = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.cobrowse', 'settings.json'), 'utf8')
    ) as { agentProviders?: Array<{ name?: string; baseUrl?: string; apiKey?: string; model?: string }> }
    const p = (d.agentProviders ?? []).find((x) => String(x.name ?? '').toLowerCase().includes(name))
    if (!p?.apiKey || !p.baseUrl) return null
    return { baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model ?? '' }
  } catch {
    return null
  }
}

describe.skipIf(!live)('live LLM smoke (openai-chat)', () => {
  it(
    'deepseek round trip',
    async () => {
      const cfg = pick('deepseek')
      if (!cfg) throw new Error('no deepseek provider configured')
      const res = await chatStream({
        protocol: 'openai-chat',
        ...cfg,
        messages: [{ role: 'user', content: '请只回复两个字：pong' }]
      })
      // eslint-disable-next-line no-console
      console.log('live reply:', JSON.stringify(res.text.slice(0, 100)))
      expect(res.text.trim().length).toBeGreaterThan(0)
    },
    90_000
  )
})
