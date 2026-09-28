import { useEffect, useState } from 'react'

interface SkillInfo {
  id: string
  name: string
  description: string
  source: 'duplex' | 'claude'
  dir: string
  enabled: boolean
}

interface CodexStatus {
  found: boolean
  configured: boolean
  path: string
  backupPath?: string
}

/**
 * Skill manager + CLI integration entry: list/import/toggle skills, and set
 * up the MCP connection for Codex / Claude Code.
 */
export function SkillsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [codex, setCodex] = useState<CodexStatus | null>(null)
  const [claudeCmd, setClaudeCmd] = useState<{ command: string; hint: string; bridgeFound: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [delStage, setDelStage] = useState<{ id: string; stage: number } | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const s = (await window.cobrowse.skillsList()) as SkillInfo[]
      setSkills(Array.isArray(s) ? s : [])
      setCodex((await window.cobrowse.setupCodexStatus()) as CodexStatus)
    } catch (e) {
      setError((e as Error)?.message ?? '读取失败')
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    await window.cobrowse.skillsToggle(id, enabled)
    await refresh()
  }

  const remove = async (id: string): Promise<void> => {
    if (!delStage || delStage.id !== id) {
      setDelStage({ id, stage: 1 })
      setTimeout(() => setDelStage((c) => (c && c.id === id ? null : c)), 4000)
      return
    }
    if (delStage.stage === 1) {
      setDelStage({ id, stage: 2 })
      return
    }
    setDelStage(null)
    const r = await window.cobrowse.skillsRemove(id)
    if (!r.ok) setError(r.error ?? '删除失败')
    await refresh()
  }

  const importFolder = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const r = await window.cobrowse.skillsImportFolder()
    setBusy(false)
    if (!r.ok && r.error !== '已取消') setError(r.error ?? '导入失败')
    await refresh()
  }

  const installCodex = async (): Promise<void> => {
    if (!codex) return
    const ok = window.confirm(
      `将把 Duplex 的 MCP 配置写入：\n${codex.path}\n\n（会自动备份原文件）确定继续？`
    )
    if (!ok) return
    const r = await window.cobrowse.setupCodexInstall()
    if (!r.ok) {
      setError(r.error ?? '写入失败')
    } else if (r.backupPath) {
      window.alert(`已写入配置。原文件备份：\n${r.backupPath}`)
    } else {
      window.alert('已写入配置（原文件不存在，已新建）。')
    }
    await refresh()
  }

  const showClaude = async (): Promise<void> => {
    const r = await window.cobrowse.setupClaudeCommand()
    setClaudeCmd(r)
  }

  const duplexCount = skills.filter((s) => s.source === 'duplex').length
  const claudeCount = skills.filter((s) => s.source === 'claude').length

  return (
    <div className="providers-panel skills-panel">
      <div className="providers-head">
        <span>Skills</span>
        <span className="dim">
          {skills.length} 个（专用 {duplexCount} / Claude {claudeCount}）
        </span>
        <button className="panel-collapse" title="关闭" onClick={onClose}>
          »
        </button>
      </div>

      <div className="providers-list">
        {skills.length === 0 && (
          <div className="providers-empty">未发现 skill — 可导入文件夹（需含 SKILL.md），或先用 Claude Code 装一些</div>
        )}
        {skills.map((s) => (
          <div key={s.id} className="provider-item skill-item" title={s.dir}>
            <div className="provider-info">
              <div className="provider-name">
                {s.name}
                <span className="provider-tag">{s.source === 'duplex' ? '专用' : 'Claude'}</span>
              </div>
              <div className="provider-sub skill-desc">{s.description || '（无描述）'}</div>
            </div>
            <label
              className="skill-switch"
              title={s.enabled ? '已启用（点击停用）' : '已停用（点击启用）'}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => void toggle(s.id, e.target.checked)}
              />
            </label>
            {s.source === 'duplex' ? (
              <button
                className={`provider-mini ${delStage?.id === s.id ? 'danger' : ''}`}
                title="删除（需连续确认三次）"
                onClick={() => void remove(s.id)}
              >
                {delStage?.id === s.id ? (delStage.stage === 1 ? '确认?' : '再确认!') : '✕'}
              </button>
            ) : (
              <span className="provider-mini skill-lock" title="Claude 来源（只读）">
                ·
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="provider-actions">
        <button disabled={busy} onClick={() => void importFolder()}>
          ＋ 导入文件夹
        </button>
      </div>

      <div className="providers-head skills-subhead">
        <span>CLI 接入</span>
      </div>
      <div className="skills-integration">
        {codex && (
          <div className="integration-row">
            <div className="provider-sub">
              Codex：{codex.found ? (codex.configured ? '已接入 ✓' : '未接入') : '未找到 config.toml'}
            </div>
            <button className="import-btn" onClick={() => void installCodex()}>
              接入 Codex
            </button>
          </div>
        )}
        <div className="integration-row">
          <div className="provider-sub">Claude Code：复制命令后到终端执行</div>
          <button className="import-btn" onClick={() => void showClaude()}>
            显示命令
          </button>
        </div>
        {claudeCmd && <pre className="integration-cmd">{claudeCmd.command}</pre>}
        {claudeCmd && !claudeCmd.bridgeFound && (
          <div className="import-status">
            注意：未找到 dist-bridge/index.cjs——请先在项目根运行 npm run build:bridge
          </div>
        )}
      </div>

      {error && <div className="agent-form-err providers-err">{error}</div>}
    </div>
  )
}
