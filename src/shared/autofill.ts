/**
 * 密码自动填充的表单识别与 origin 匹配——**纯函数，无 Node / Electron 依赖**。
 *
 * 产品红线（docs/research-adblock-autofill-ua.md §2.2）：
 *  - 密码不属于「AI 在安全范围内可以做的一切」。本文件只回答"填不填、填哪个框"，
 *    永远不接触明文；取明文只有 PasswordVault.reveal() 一个入口。
 *  - **只对精确 origin 填充**：子域、协议降级、端口变化一律不填。
 *  - 填充 UI 必须画在 chrome 里（页面可以伪造任何控件），本文件只管判定。
 */

const HTTP_SCHEMES = new Set(['http:', 'https:'])

function formatOrigin(protocol: string, host: string, port: string): string {
  const fallback = protocol === 'https:' ? '443' : '80'
  return port && port !== fallback ? `${protocol}//${host}:${port}` : `${protocol}//${host}`
}

/**
 * 从页面 URL 提取规范化 origin（`scheme://host[:port]`）：
 * 只接受 http/https，丢掉路径、查询与锚点；主机名小写、默认端口省略。
 * 非法输入（非 http(s)、空串、带内嵌凭据）返回 null。
 */
export function originOf(rawUrl: string | null | undefined): string | null {
  const raw = (rawUrl ?? '').trim()
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (!HTTP_SCHEMES.has(u.protocol)) return null
  // 带内嵌凭据的地址不是正常页面地址，直接拒绝
  if (u.username || u.password) return null
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return null
  return formatOrigin(u.protocol, host, u.port)
}

/**
 * 目标页面的 origin 是否可以填入保存的 origin。
 *
 * **必须精确相等**——两侧都应先经 originOf() / PasswordVault 规范化。这里刻意
 * 不做任何"看起来一样"的宽容匹配（忽略大小写、去掉 www、比主域、把 http 当
 * https、忽略端口），每一条都是钓鱼与降级的入口：
 *  - `https://mail.example.com` 的密码绝不填给 `https://example.com`，反之亦然
 *  - `https://a.com` 的密码绝不填给 `http://a.com`（协议降级会把密码明文上网）
 */
export function canFillInto(targetOrigin: string, savedOrigin: string): boolean {
  if (!targetOrigin || !savedOrigin) return false
  return targetOrigin === savedOrigin
}

export interface FieldDescriptor {
  /** 字段在表单里的稳定序号；返回结果用它指代字段，不是数组下标。 */
  index: number
  type?: string
  name?: string
  id?: string
  autocomplete?: string
  /** 扫描时的可见性；`false` 表示不可交互，一律忽略。 */
  visible?: boolean
}

/** 用户名/邮箱类输入框的 name/id 关键词。 */
const USERNAME_KEYS = /(user|email|login|account)/i

/** 可以被当作用户名输入框的 type（按钮/勾选框即使叫 login 也不能填）。 */
const TEXT_ENTRY_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'search', 'number'])

function autocompleteTokens(value: string | undefined): string[] {
  return (value ?? '').toLowerCase().split(/\s+/).filter(Boolean)
}

/** 用户看不见的字段不该被自动填充（否则可能把值填进 CSRF 隐藏域之类的地方）。 */
function isHidden(field: FieldDescriptor): boolean {
  return field.visible === false || (field.type ?? '').toLowerCase() === 'hidden'
}

function isPasswordField(field: FieldDescriptor): boolean {
  const type = (field.type ?? '').toLowerCase()
  return type === 'password' || autocompleteTokens(field.autocomplete).includes('current-password')
}

function looksLikeUsername(field: FieldDescriptor): boolean {
  if (!TEXT_ENTRY_TYPES.has((field.type ?? '').toLowerCase())) return false
  const tokens = autocompleteTokens(field.autocomplete)
  if (tokens.includes('username')) return true
  // 显式标成密码语义的字段不参与用户名猜测（注册/改密场景）
  if (tokens.includes('current-password') || tokens.includes('new-password')) return false
  return USERNAME_KEYS.test(field.name ?? '') || USERNAME_KEYS.test(field.id ?? '')
}

/**
 * 从页面扫描到的字段里挑出用户名框与密码框。
 *
 * 规则（宁缺毋滥）：
 *  - 密码框：`type=password` 或 `autocomplete=current-password`
 *  - 用户名框：`autocomplete=username`，或 name/id 含 user/email/login/account
 *  - 不可见字段（visible=false 或 type=hidden）一律忽略
 *  - 只取**第一个**用户名框；密码框按 index 升序全部返回（多步登录/确认框由上层决定填哪个）
 */
export function classifyFields(fields: FieldDescriptor[]): { userField?: number; passwordFields: number[] } {
  const passwordFields: number[] = []
  let userField: number | undefined
  for (const field of fields) {
    if (isHidden(field)) continue
    if (isPasswordField(field)) {
      passwordFields.push(field.index)
      continue
    }
    if (userField === undefined && looksLikeUsername(field)) userField = field.index
  }
  passwordFields.sort((a, b) => a - b)
  return { userField, passwordFields }
}

/**
 * 表单提交后要不要弹出"保存密码"。
 *
 * 四个条件缺一不可：真的是用户提交了表单（不是脚本触发的中间态）、表单里确实有
 * 密码框、密码相对已存值发生了变化、该 origin+用户名还没有存过。最后一条避免每次
 * 登录都重复询问——**更新旧密码属于 P2**，走的是另一条（仍然必须由真人确认的）
 * 流程，不在这个"新存一条"的判定里。
 */
export function shouldOfferSave(input: {
  submittedForm: boolean
  hasPassword: boolean
  passwordChanged: boolean
  originStoredForUser: boolean
}): boolean {
  if (!input.submittedForm) return false
  if (!input.hasPassword) return false
  if (!input.passwordChanged) return false
  return !input.originStoredForUser
}
