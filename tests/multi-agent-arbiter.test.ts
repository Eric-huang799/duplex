import { describe, expect, it } from 'vitest'
import { MultiAgentArbiter } from '../src/main/multi-agent-arbiter'

/** 可注入的假时钟 + sleep，让等待/超时可测且不真的等。 */
function harness(navTimeoutMs = 3000) {
  let clock = 0
  const arbiter = new MultiAgentArbiter({
    now: () => clock,
    navTimeoutMs,
    pollMs: 5,
    sleep: async (ms) => {
      clock += ms
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  })
  return { arbiter, advance: (ms: number) => (clock += ms), clock: () => clock }
}

describe('导航屏障', () => {
  it('其它 agent 有在途操作时，导航要等它结束', async () => {
    const { arbiter } = harness()
    const token = arbiter.beginOperation('agent-a', 1)
    let released = false
    setTimeout(() => {
      arbiter.endOperation(token)
      released = true
    }, 20)

    const decision = await arbiter.requestNavigation('agent-b', 1)
    expect(released).toBe(true)
    expect(decision.ok).toBe(true)
    expect(decision.preempted).toEqual([])
    expect(decision.timedOut).toBe(false)
  })

  it('没有人占用时导航立即放行（等待为 0）', async () => {
    const { arbiter } = harness()
    const decision = await arbiter.requestNavigation('agent-b', 1)
    expect(decision.waitedMs).toBe(0)
    expect(decision.preempted).toEqual([])
  })

  it('等待超过上限时抢占并放行，且被抢占的 agent 会明确失败', async () => {
    const { arbiter } = harness(30)
    const token = arbiter.beginOperation('agent-a', 1)

    const decision = await arbiter.requestNavigation('agent-b', 1)
    expect(decision.timedOut).toBe(true)
    expect(decision.preempted).toEqual(['agent-a'])
    expect(token.aborted).toBe(true)

    // 被中断的 agent 在动作前必须失败，不能静默继续
    expect(() => arbiter.assertNotAborted(token, '点击')).toThrow(/已被中断/)
    // 未受影响的 token 不抛
    const other = arbiter.beginOperation('agent-c', 2)
    expect(() => arbiter.assertNotAborted(other, '点击')).not.toThrow()
  })

  it('强制导航立即抢占', async () => {
    const { arbiter } = harness()
    arbiter.beginOperation('agent-a', 1)
    const decision = await arbiter.requestNavigation('agent-b', 1, { force: true })
    expect(decision.waitedMs).toBe(0)
    expect(decision.preempted).toEqual(['agent-a'])
  })

  it('只针对同一标签：别的标签上的操作不阻塞导航', async () => {
    const { arbiter } = harness(10)
    arbiter.beginOperation('agent-a', 2)
    const decision = await arbiter.requestNavigation('agent-b', 1)
    expect(decision.timedOut).toBe(false)
    expect(decision.preempted).toEqual([])
  })
})

describe('误跳转回退', () => {
  it('跳转发生后急停其它 agent，并给出回退地址', () => {
    const { arbiter } = harness()
    const token = arbiter.beginOperation('agent-a', 1)
    const result = arbiter.handleUnexpectedNavigation(1, 'agent-b', 'https://example.com/form')
    expect(result.stopped).toEqual(['agent-a'])
    expect(result.rollbackTo).toBe('https://example.com/form')
    expect(token.aborted).toBe(true)
  })
})

describe('同一目标争用', () => {
  it('互斥：并发 20 个请求，任一时刻只有一个在执行', async () => {
    const { arbiter } = harness()
    let active = 0
    let maxActive = 0
    let done = 0
    const tasks = Array.from({ length: 20 }, (_, i) =>
      arbiter.withTarget(`agent-${i}`, 1, 'e12', async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active--
        done++
      })
    )
    await Promise.all(tasks)
    expect(done).toBe(20)
    expect(maxActive).toBe(1)
  })

  it('按 agent 编号加权排序：编号小的先执行', async () => {
    const { arbiter } = harness()
    const order: string[] = []
    // 先占住目标，保证三个请求都在等待队列里，再由释放顺序体现权重
    const holder = arbiter.withTarget('holder', 1, 'btn', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await new Promise((resolve) => setTimeout(resolve, 1))
    const waiting = ['agent-3', 'agent-1', 'agent-2'].map((id) =>
      arbiter.withTarget(id, 1, 'btn', async () => {
        order.push(id)
      })
    )
    await Promise.all([holder, ...waiting])
    expect(order).toEqual(['agent-1', 'agent-2', 'agent-3'])
  })

  it('权重相同时按发起顺序（先到先执行）', async () => {
    const { arbiter } = harness()
    for (const id of ['agent-x', 'agent-y', 'agent-z']) arbiter.setWeight(id, 5)
    const order: string[] = []
    const holder = arbiter.withTarget('holder', 1, 'btn', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await new Promise((resolve) => setTimeout(resolve, 1))
    const waiting = ['agent-x', 'agent-y', 'agent-z'].map((id) =>
      arbiter.withTarget(id, 1, 'btn', async () => {
        order.push(id)
      })
    )
    await Promise.all([holder, ...waiting])
    expect(order).toEqual(['agent-x', 'agent-y', 'agent-z'])
  })

  it('不同目标互不阻塞', async () => {
    const { arbiter } = harness()
    const started: string[] = []
    await Promise.all([
      arbiter.withTarget('agent-a', 1, 'btn-1', async () => {
        started.push('a')
        await new Promise((resolve) => setTimeout(resolve, 15))
      }),
      arbiter.withTarget('agent-b', 1, 'btn-2', async () => {
        started.push('b')
      })
    ])
    expect(started).toEqual(['a', 'b'])
  })

  it('执行体抛错时持有权仍会被释放（不会锁死目标）', async () => {
    const { arbiter } = harness()
    await expect(
      arbiter.withTarget('agent-a', 1, 'btn', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    // 后续请求能拿到锁
    await expect(arbiter.withTarget('agent-b', 1, 'btn', async () => 'ok')).resolves.toBe('ok')
  })
})

describe('权重', () => {
  it('稳定：同一 agent 任何时候都得到同一权重', () => {
    const a = new MultiAgentArbiter()
    const b = new MultiAgentArbiter()
    expect(a.priorityOf('agent-7')).toBe(b.priorityOf('agent-7'))
    expect(a.priorityOf('agent-7')).not.toBe(a.priorityOf('agent-8'))
  })

  it('id 末尾的编号优先：agent-3 排在 agent-12 之前', () => {
    const arbiter = new MultiAgentArbiter()
    expect(arbiter.priorityOf('agent-3')).toBe(3)
    expect(arbiter.priorityOf('agent-12')).toBe(12)
    expect(arbiter.priorityOf('agent-3')).toBeLessThan(arbiter.priorityOf('agent-12'))
  })

  it('没有编号的 id 退回稳定哈希（落在 0..999）', () => {
    const arbiter = new MultiAgentArbiter()
    const weight = arbiter.priorityOf('client-abcxyz')
    expect(weight).toBeGreaterThanOrEqual(0)
    expect(weight).toBeLessThan(1000)
  })

  it('显式权重覆盖编号与哈希', () => {
    const arbiter = new MultiAgentArbiter()
    arbiter.setWeight('agent-9', 1)
    expect(arbiter.priorityOf('agent-9')).toBe(1)
  })
})
