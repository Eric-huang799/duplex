import crypto from 'node:crypto'

/**
 * 外部 agent（MCP bridge）的稳定身份。
 *
 * 之前所有 bridge 共用一个 `bridge:<目录哈希>`，于是**不同项目里的两个 agent
 * 在应用看来是同一个人**：授权、ref 命名空间、仲裁键全部合并，多 agent 等于没接线。
 *
 * 现在按"安装 + 工作目录"区分：
 *  1. `DUPLEX_CALLER_ID` 显式指定（受控环境、测试、同一项目多开时手动区分）；
 *  2. 否则 `bridge:<目录哈希>-<cwd 哈希>`：同一项目重启后身份不变（"始终允许"不会每次重问），
 *     不同工作目录则是不同 agent。
 *
 * 只输出 ASCII 标识符，与 HTTP 头 `duplex-caller-id` 的校验规则一致（1–128 字符）。
 */
export const CALLER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export interface CallerIdInput {
  env?: NodeJS.ProcessEnv
  cwd?: string
  dataDir: string
}

export function bridgeCallerId(input: CallerIdInput): string {
  const env = input.env ?? process.env
  const override = (env['DUPLEX_CALLER_ID'] ?? '').trim()
  if (override && CALLER_ID_PATTERN.test(override)) return override
  const dataHash = crypto.createHash('sha1').update(input.dataDir).digest('hex').slice(0, 8)
  const cwdHash = crypto
    .createHash('sha1')
    .update(input.cwd ?? process.cwd())
    .digest('hex')
    .slice(0, 8)
  return `bridge:${dataHash}-${cwdHash}`
}
