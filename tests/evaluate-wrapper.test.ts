import { describe, expect, it } from 'vitest'
import { wrapEvaluateScript } from '../src/main/playwright-browser'

describe('evaluate 脚本包装', () => {
  it('裸表达式补上 return', () => {
    expect(wrapEvaluateScript('document.title')).toBe('return (document.title)')
    expect(wrapEvaluateScript('1 + 1')).toBe('return (1 + 1)')
    expect(wrapEvaluateScript('JSON.stringify({a:1})')).toBe('return (JSON.stringify({a:1}))')
  })

  it('已带 return 的脚本保持原样（不能二次包装）', () => {
    const script = 'const x = 1\nreturn x + 1'
    expect(wrapEvaluateScript(script)).toBe(script)
  })

  it('语句块无法作为表达式解析时原样执行', () => {
    const script = 'if (document.title) { document.title = "x" }'
    expect(wrapEvaluateScript(script)).toBe(script)
  })

  it('支持 await 表达式', () => {
    expect(wrapEvaluateScript('await fetch("/x").then(r => r.status)')).toBe(
      'return (await fetch("/x").then(r => r.status))'
    )
  })
})
