/**
 * 站点权限工具（只给内置 agent，`internal: true`，外部 MCP 客户端看不到）。
 *
 * 产品原则：AI 在安全范围内可以做一切有益于用户的事情。
 * 这里的落点就是——**收紧不需要问，放宽才需要问**：
 *   - `deny` / `ask`：随时可写，属于安全方向
 *   - `allow` 且类别是 high-risk（摄像头、屏幕共享、设备…）：必须人工确认
 *   - `allow` 且类别是 silent/sensitive：直接生效，但会被记录成 `source: 'agent'`，
 *     用户能在设置页按"AI 改过哪些权限"一眼看到并撤销
 */
import type { ToolResult } from '../tool-handlers'
import type { PermissionStore } from '../permission-store'
import {
  ALL_CATEGORIES,
  agentGrantNeedsConfirmation,
  isGrantableOrigin,
  normalizeOrigin,
  type Decision,
  type PermissionCategory
} from '../../shared/permissions'

export type PermissionConfirmFn = (payload: {
  command: string
  cwd: string
  skill: string
  tool?: string
  kind?: 'write' | 'command' | 'script'
  preview?: string
}) => Promise<boolean>

function text(text: string, isError = false): ToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text }]
  }
}

function parseCategory(raw: unknown): PermissionCategory | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return (ALL_CATEGORIES as string[]).includes(value) ? (value as PermissionCategory) : null
}

export function createSitePermissionHandlers(
  confirm: PermissionConfirmFn,
  store: () => PermissionStore | null
): Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> {
  return {
    async list_site_permissions(): Promise<ToolResult> {
      const permissions = store()
      if (!permissions) return text('权限存储尚未就绪', true)
      return text(
        JSON.stringify(
          {
            categories: ALL_CATEGORIES,
            global: permissions.globalDecisions(),
            origins: permissions.list()
          },
          null,
          2
        )
      )
    },

    async set_site_permission(args): Promise<ToolResult> {
      const permissions = store()
      if (!permissions) return text('权限存储尚未就绪', true)

      const origin = normalizeOrigin(typeof args.origin === 'string' ? args.origin : '')
      if (!origin) {
        return text(
          'origin 必须是裸 origin：形如 https://example.com，不能带路径、查询串或凭据。',
          true
        )
      }
      if (!isGrantableOrigin(origin)) {
        return text('只能为 https 站点（或 localhost）记录放行，不接受明文 http 的公网地址。', true)
      }

      const category = parseCategory(args.category)
      if (!category) {
        return text(`未知类别。可选：${ALL_CATEGORIES.join('、')}`, true)
      }

      const rawDecision = args.decision
      const decision: Decision | null =
        rawDecision === 'allow' || rawDecision === 'ask' || rawDecision === 'deny'
          ? rawDecision
          : null
      if (!decision) return text('decision 必须是 allow / ask / deny 之一。', true)

      // 收紧是安全方向，直接生效；放宽高危类别必须让用户点头。
      if (decision === 'allow' && agentGrantNeedsConfirmation(category)) {
        const approved = await confirm({
          command: `允许 ${origin} 使用${category}`,
          cwd: '',
          skill: '站点权限',
          tool: 'set_site_permission',
          kind: 'write',
          preview: `站点：${origin}\n类别：${category}\n操作：允许并记住`
        })
        if (!approved) {
          return text('用户拒绝了这次放行，未写入任何规则。请尊重该决定，不要再次尝试。', true)
        }
      }

      const result = permissions.set(origin, category, decision, 'agent')
      if (!result.ok) return text(`写入失败：${result.error}`, true)
      if (!result.changed) return text(`规则未变化：${origin} 的 ${category} 已经是 ${decision}。`)

      const label = decision === 'allow' ? '已放行' : decision === 'deny' ? '已拒绝' : '已改回询问'
      return text(`${label}：${origin} → ${category}（记录来源为 agent，可在设置里撤销）`)
    },

    async remove_site_permission(args): Promise<ToolResult> {
      const permissions = store()
      if (!permissions) return text('权限存储尚未就绪', true)

      const origin = normalizeOrigin(typeof args.origin === 'string' ? args.origin : '')
      if (!origin) return text('origin 必须是裸 origin。', true)

      const rawCategory = args.category
      let category: PermissionCategory | undefined
      if (rawCategory != null) {
        const parsed = parseCategory(rawCategory)
        if (!parsed) return text('未知类别。', true)
        category = parsed
      }

      const removed = permissions.remove(origin, category)
      if (!removed.ok) return text('origin 无效。', true)
      return text(
        removed.removed > 0
          ? `已移除 ${removed.removed} 条规则（${origin}）。`
          : `没有匹配的规则（${origin}）。`
      )
    }
  }
}
