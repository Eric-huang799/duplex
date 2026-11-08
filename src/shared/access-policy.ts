/**
 * 访问治理：谁可以访问什么，以及什么时候必须先问用户。
 *
 * 两层，刻意分开：
 *
 *  1. **检索中立**：浏览器**不**过滤、不降权、不隐瞒搜索结果。用户搜什么就给什么，
 *     用不用由用户决定。这一层没有策略代码——因为"不干预"本身就是实现方式。
 *  2. **访问授权**：真正需要把门的是**访问动作**，尤其是 AI 代访问。
 *     未授权站点 / 敏感站点由这里判定，返回"需要用户确认"而不是"禁止"。
 *
 * 关键区别（也是这个产品的立场）：
 *  - 对**人**：任何站点都能打开，最多提示风险，绝不拦截浏览。替用户做内容审查是越界。
 *  - 对 **AI**：默认服从用户，但进入未授权/敏感站点前必须先取得授权；
 *    被拒绝后不得更换标签、改写 URL、或换搜索引擎绕过。
 *  - 对**多个 AI**：授权按 `(actor, origin)` 匹配。一个 agent 的授权不会
 *    顺带放行另一个 agent——调用方必须给出具体 `agentId`，缺省视为未授权。
 *
 * 这个模块是纯函数：输入 actor（角色）、agentId（具体 agent 身份）、目标 URL、
 * (actor, origin) 授权记录，输出决定与理由。
 */
import { classifySite, type SensitivityVerdict } from './sensitive-sites'

/** 语义角色：human 永远放行；agent 进入前要过授权表。 */
export type Actor = 'human' | 'agent'

export type AccessDecision = 'allow' | 'need-consent' | 'deny'

/** 一条站点授权：某个 agent 对某个 origin 的许可。 */
export interface SiteGrant {
  /** 请求方 agent 的稳定标识（主进程 `currentCaller()`）。 */
  actor: string
  /** 规范化 origin（`accessOrigin()` 的结果）。 */
  origin: string
}

export interface AccessInput {
  actor: Actor
  /**
   * 具体的 agent 身份（`currentCaller()`），只在 `actor === 'agent'` 时有意义。
   * 缺失 / 为空 → 一律视为未授权（宁可多问一次，也不猜归属）。
   */
  agentId?: string
  url: string
  /**
   * 全量 (actor, origin) 授权记录。只有 `actor` 与 `agentId` 相同、且 origin
   * 精确相同的记录才算数；不要传"所有 agent 的 origin 合集"。
   */
  grants?: readonly SiteGrant[]
  /** 用户是否已经关闭"AI 可访问未授权站点"的总闸。 */
  agentMayBrowseUnlisted?: boolean
}

export interface AccessResult {
  decision: AccessDecision
  /** 命中的敏感类别（如果是敏感站点）。 */
  sensitivity?: SensitivityVerdict
  /** 给用户/agent 看的一句话理由。 */
  reason?: string
}

/** 取规范化 origin（用于授权集合比对）；无法解析返回 null。 */
export function accessOrigin(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!host) return null
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`
  } catch {
    return null
  }
}

/**
 * 是否已授权：按 (agentId, origin) 精确匹配。
 * 没有 agentId 或授权记录时一律 false——绝不回退到"全站共享"。
 */
function isAuthorized(
  origin: string | null,
  agentId: string | undefined,
  grants: AccessInput['grants']
): boolean {
  if (!origin || !agentId || !grants) return false
  for (const grant of grants) {
    if (!grant || grant.actor !== agentId) continue
    // 容忍调用方传入未规范化的 origin（例如带路径/尾斜杠），但只比较 origin。
    if (accessOrigin(grant.origin) === origin) return true
  }
  return false
}

export function decideAccess(input: AccessInput): AccessResult {
  const origin = accessOrigin(input.url)

  // 非 http(s)、回环、无法解析：不归这套治理管（本地开发、自家面板）
  if (!origin) return { decision: 'allow' }

  // 人：永远放行。可以提示风险，但不拦 browsing —— 内核不做内容审查。
  if (input.actor === 'human') {
    const sensitivity = classifySite(input.url)
    return sensitivity.sensitive
      ? { decision: 'allow', sensitivity, reason: '真人浏览，只提示不拦截' }
      : { decision: 'allow' }
  }

  // Agent：先看敏感，再看该 agent 是否已授权
  const sensitivity = classifySite(input.url)
  const authorized = isAuthorized(origin, input.agentId, input.grants)

  if (sensitivity.sensitive) {
    return authorized
      ? { decision: 'allow', sensitivity }
      : {
          decision: 'need-consent',
          sensitivity,
          reason: `${sensitivity.reason ?? '敏感站点'}：AI 进入前需要用户授权`
        }
  }

  if (authorized) return { decision: 'allow' }

  // 非敏感但未在授权列表里：取决于用户是否允许 AI 访问未列出的站点
  if (input.agentMayBrowseUnlisted === false) {
    return { decision: 'need-consent', reason: '未授权的站点：AI 进入前需要用户授权' }
  }
  return { decision: 'allow' }
}

/** 授权被拒绝时给 agent 的固定指引：不要绕过。 */
export const DENIED_GUIDANCE =
  '用户没有授权访问该站点。不要重试，不要更换标签、改写 URL 或换搜索引擎绕过；请停止该部分任务并告知用户。'
