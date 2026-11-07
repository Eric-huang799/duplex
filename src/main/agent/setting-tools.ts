/**
 * 给内置 agent 的"浏览器设置"工具。
 *
 * 用户的要求：AI 应该有能力帮用户调整这些功能。这里遵守两条：
 *  - **改动前先建还原点**（`settings.pre-ai.json`），让用户永远有一条退路；
 *  - 每个改动都返回"新状态 + 怎么撤销"，而不是让 AI 只说一句"改好了"。
 *
 * 注意：密码库**不在此列**。凭据不属于"AI 可以帮忙调整"的范围。
 */
import type { ToolResult } from '../tool-handlers'

export interface AdblockSnapshot {
  enabled: boolean
  domains?: number
  regex?: number
  cosmetic?: number
  accepted?: number
  skipped?: number
}

export interface SettingToolDeps {
  /** 当前广告拦截状态（含引擎规模，便于用户判断"规则有没有加载"）。 */
  getAdblock: () => AdblockSnapshot
  /** 应用并持久化；内部负责确保还原点已建立。 */
  setAdblock: (enabled: boolean) => { ok: boolean; error?: string }
  /** 恢复到 AI 改动之前的快照。 */
  restore: () => { ok: boolean; error?: string }
  /** 该功能当前是否允许被修改（例如以后可加"AI 不得改设置"的总闸）。 */
  canModify?: () => boolean
}

function text(body: string, isError = false): ToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: body }] }
}

export function createSettingToolHandlers(
  deps: SettingToolDeps
): Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> {
  const guard = (): ToolResult | null =>
    deps.canModify && !deps.canModify()
      ? text('用户已关闭"允许 AI 调整设置"，本次调用被拒绝。请让用户自己在界面里改。', true)
      : null

  return {
    async get_settings_status(): Promise<ToolResult> {
      const adblock = deps.getAdblock()
      return text(
        JSON.stringify(
          {
            adblock: {
              enabled: adblock.enabled,
              rules: {
                domains: adblock.domains ?? 0,
                regex: adblock.regex ?? 0,
                cosmetic: adblock.cosmetic ?? 0
              },
              lastParse: { accepted: adblock.accepted ?? 0, skipped: adblock.skipped ?? 0 }
            }
          },
          null,
          2
        )
      )
    },

    async set_adblock(args): Promise<ToolResult> {
      const blocked = guard()
      if (blocked) return blocked
      if (typeof args.enabled !== 'boolean') {
        return text('enabled 必须是 true 或 false。', true)
      }
      const result = deps.setAdblock(args.enabled)
      if (!result.ok) return text(`设置失败：${result.error ?? '未知错误'}`, true)
      const state = deps.getAdblock()
      return text(
        `广告拦截已${state.enabled ? '开启' : '关闭'}。${
          state.enabled ? `已加载 ${state.domains ?? 0} 条域名规则、${state.regex ?? 0} 条正则规则。` : '当前不拦截任何请求。'
        }\n改动前已留有还原点；用户可以随时说"把设置恢复到我原来的样子"来撤销。`
      )
    },

    async restore_settings(args): Promise<ToolResult> {
      const blocked = guard()
      if (blocked) return blocked
      if (args.confirm !== true) {
        return text(
          '这会用 AI 改动之前的快照覆盖当前设置。确认要恢复请带 confirm: true 重新调用（这是唯一需要二次确认的设置操作）。',
          true
        )
      }
      const result = deps.restore()
      if (!result.ok) return text(`恢复失败：${result.error ?? '未知错误'}`, true)
      return text('已恢复到 AI 改动之前的设置快照；恢复前的状态另存为 settings.before-restore.json。')
    }
  }
}
