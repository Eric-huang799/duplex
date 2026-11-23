import type { MirrorToolEvent } from '../../../shared/protocol'
import { ShieldIcon } from './PermissionCard'
import { useI18n } from '../i18n'

const STATUS_ICON: Record<MirrorToolEvent['status'], string> = {
  pending: '⋯',
  running: '◌',
  completed: '✓',
  error: '✗'
}

const OUTPUT_LIMIT = 2500
const ERROR_LIMIT = 1500

const TOOL_LABEL: Record<string, string> = {
  navigate: '打开网页',
  search: '搜索',
  snapshot: '查看页面',
  get_html: '读取页面代码',
  query: '查找元素',
  screenshot: '截图',
  click: '点击',
  type: '输入',
  press: '按键',
  scroll: '滚动',
  hover: '悬停',
  dblclick: '双击',
  drag: '拖拽',
  select_option: '选择选项',
  upload: '上传文件',
  wait: '等待',
  get_console: '读取控制台',
  evaluate: '执行脚本',
  read_skill: '读取技能',
  list_skill_files: '查看技能文件',
  read_skill_file: '读取技能文件',
  run_skill_script: '运行技能脚本',
  write_file: '写文件',
  run_command: '运行命令',
  design_open: '打开设计画布',
  design_read: '读取设计',
  design_patch: '修改设计',
  design_variants: '生成备选方案',
  design_commit: '保存设计版本',
  design_export: '导出网页'
}

function humanSummary(ev: MirrorToolEvent): string {
  const input = (ev.input ?? {}) as Record<string, unknown>
  switch (ev.tool) {
    case 'design_patch':
      return Array.isArray(input['ops']) ? `修改 ${input['ops'].length} 处` : '修改设计'
    case 'navigate':
      return String(input['url'] ?? '')
    case 'click':
    case 'hover':
    case 'dblclick':
      return String(input['target'] ?? input['selector'] ?? '')
    case 'type':
      return [input['target'], String(input['text'] ?? '').slice(0, 26)].filter(Boolean).join(' · ')
    case 'search':
      return String(input['query'] ?? '')
    case 'screenshot':
      return '截图'
    case 'run_command':
      return String(input['command'] ?? '')
    case 'write_file':
      return String(input['path'] ?? input['filePath'] ?? '')
    case 'design_export':
    case 'design_commit':
      return String(input['summary'] ?? '')
    case 'design_open':
      return ''
    case 'design_read':
      return typeof input['rootId'] === 'string' ? `区块 ${input['rootId']}` : '读取结构'
    default: {
      const text = summarizeInput(ev.input)
      // 工具卡标题不展示原始 JSON：没有可读字段就留空
      return /^\s*[\[{]/.test(text) ? '' : text
    }
  }
}

function summarizeInput(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input.slice(0, 80)
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>
    for (const k of ['description', 'command', 'filePath', 'url', 'pattern', 'query', 'prompt', 'target']) {
      const v = obj[k]
      if (typeof v === 'string' && v) return v.slice(0, 80)
    }
    const s = JSON.stringify(input)
    return s.length > 80 ? s.slice(0, 80) + '…' : s
  }
  return String(input).slice(0, 80)
}

export function ToolCard({
  ev,
  open,
  onToggle,
  waiting = false
}: {
  ev: MirrorToolEvent
  open: boolean
  onToggle: () => void
  waiting?: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const titleIsJson = typeof ev.title === 'string' && /^\s*[{[]/.test(ev.title)
  const summary = (!titleIsJson && ev.title) || humanSummary(ev)
  const toolName = TOOL_LABEL[ev.tool] ?? ev.tool
  const outputTruncated = !!ev.output && ev.output.length > OUTPUT_LIMIT
  const errorTruncated = !!ev.error && ev.error.length > ERROR_LIMIT
  return (
    <div className={`toolcard ${ev.status}${waiting ? ' waiting' : ''}`}>
      <div className="toolcard-head" onClick={onToggle} aria-expanded={open}>
        {waiting ? (
          <span className="tool-status">
            <ShieldIcon className="tool-shield" />
          </span>
        ) : (
          <span className="tool-status">{STATUS_ICON[ev.status]}</span>
        )}
        <span className="tool-name">{toolName}</span>
        {waiting ? (
          <span className="tool-title">{t('tool.waitingPermission')}</span>
        ) : (
          summary && <span className="tool-title">{summary}</span>
        )}
      </div>
      {open && (
        <div className="toolcard-body">
          {ev.input != null && (
            <pre className="tool-io">{JSON.stringify(ev.input, null, 1)}</pre>
          )}
          {ev.output && (
            <pre className="tool-io">
              {ev.output.slice(0, OUTPUT_LIMIT)}
              {outputTruncated ? '\n' + t('tool.truncated') : ''}
            </pre>
          )}
          {ev.error && (
            <pre className="tool-io err">
              {ev.error.slice(0, ERROR_LIMIT)}
              {errorTruncated ? '\n' + t('tool.truncated') : ''}
            </pre>
          )}
          {!ev.input && !ev.output && !ev.error && <div className="tool-io dim">{t('tool.noDetails')}</div>}
        </div>
      )}
    </div>
  )
}
