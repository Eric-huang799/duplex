import { describe, expect, it } from 'vitest'
import {
  abortOperation,
  beginOperation,
  endOperation,
  interruptibleAwait,
  interruptibleSleep,
  runInOperation
} from '../src/main/interrupt'

describe('interruptibleAwait / interruptibleSleep (emergency stop)', () => {
  it('resolves the fallback as soon as the operation aborts', async () => {
    const ac = beginOperation()
    const t0 = Date.now()
    const p = runInOperation(ac, async () => {
      const v = await interruptibleAwait(
        new Promise<boolean>((r) => setTimeout(() => r(true), 30_000)),
        false
      )
      return { v, ms: Date.now() - t0 }
    })
    setTimeout(() => abortOperation(), 80)
    const { v, ms } = await p
    endOperation(ac)
    expect(v).toBe(false)
    expect(ms).toBeLessThan(3000)
  })

  it('passes the value through when nothing aborts', async () => {
    const ac = beginOperation()
    const v = await runInOperation(ac, () => interruptibleAwait(Promise.resolve(42), -1))
    endOperation(ac)
    expect(v).toBe(42)
  })

  it('resolves immediately when the operation is already aborted', async () => {
    const ac = beginOperation()
    ac.abort()
    const v = await runInOperation(ac, () =>
      interruptibleAwait(new Promise<boolean>((r) => setTimeout(() => r(true), 5000)), false)
    )
    endOperation(ac)
    expect(v).toBe(false)
  })

  it('sleep ends early on abort', async () => {
    const ac = beginOperation()
    const t0 = Date.now()
    const p = runInOperation(ac, () => interruptibleSleep(30_000))
    setTimeout(() => abortOperation(), 60)
    await p
    endOperation(ac)
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})
