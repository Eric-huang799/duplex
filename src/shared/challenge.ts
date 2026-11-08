/**
 * 人机验证/挑战页检测。
 *
 * 产品决定：**不对抗、不破解**。检测到挑战就暂停 AI、把控制权交回用户，
 * 用户通过验证后再继续。这是唯一可持续的做法——自动过验证码会把产品从
 * "用户授权的代操作"变成"对抗平台的爬虫"，账号与法律风险都不可接受。
 *
 * 纯函数：输入 URL/iframe/文本，输出判定与置信度，便于单测与复用。
 */

export type ChallengeKind =
  | 'recaptcha'
  | 'hcaptcha'
  | 'turnstile'
  | 'geetest'
  | 'cloudflare'
  | 'slider'
  | 'unknown'

export interface FrameInfo {
  url?: string
  name?: string
  id?: string
  title?: string
}

export interface ChallengeSignals {
  url: string
  frames?: FrameInfo[]
  text?: string
  title?: string
}

export interface ChallengeVerdict {
  challenge: boolean
  kind?: ChallengeKind
  /** 命中的具体证据，用于向用户解释。 */
  evidence?: string
  /** 置信度 0~1。 */
  confidence: number
}

const NO_CHALLENGE: ChallengeVerdict = { challenge: false, confidence: 0 }

/** iframe/脚本域名 → 挑战类型，置信度最高的一类证据。 */
const FRAME_HOSTS: Array<{ pattern: RegExp; kind: ChallengeKind; label: string }> = [
  { pattern: /google\.com\/recaptcha|recaptcha\.net/i, kind: 'recaptcha', label: 'reCAPTCHA 组件' },
  { pattern: /hcaptcha\.com/i, kind: 'hcaptcha', label: 'hCaptcha 组件' },
  { pattern: /challenges\.cloudflare\.com|turnstile/i, kind: 'turnstile', label: 'Cloudflare Turnstile 组件' },
  { pattern: /geetest\.com|gtimg\.cn/i, kind: 'geetest', label: '极验验证组件' }
]

/** URL 路径信号：Cloudflare 等拦截页。 */
const URL_PATTERNS: Array<{ pattern: RegExp; kind: ChallengeKind; label: string }> = [
  { pattern: /\/cdn-cgi\/challenge-platform\/|cf-chl/i, kind: 'cloudflare', label: 'Cloudflare 挑战页' },
  { pattern: /\/sorry\//i, kind: 'cloudflare', label: '拦截页 (/sorry/)' },
  { pattern: /\/(captcha|verify|challenge)(\/|$|\?)/i, kind: 'unknown', label: '验证路径' }
]

/** 文本/标题关键词。中文与英文都要覆盖。 */
const TEXT_PATTERNS: Array<{ pattern: RegExp; kind: ChallengeKind; label: string }> = [
  { pattern: /verify(ing)? (that )?you are (a )?human/i, kind: 'unknown', label: '确认您是真人' },
  { pattern: /unusual traffic from your computer/i, kind: 'unknown', label: '异常流量提示' },
  { pattern: /i'?m not a robot/i, kind: 'unknown', label: '我不是机器人' },
  { pattern: /checking your browser before accessing/i, kind: 'cloudflare', label: 'Cloudflare 校验中' },
  { pattern: /确认您是真人|请完成安全验证|人机验证|安全验证|访问验证/i, kind: 'unknown', label: '中文验证提示' },
  { pattern: /拖动滑块|向右滑动|drag the slider|slide to verify/i, kind: 'slider', label: '滑块验证' }
]

function frameText(frame: FrameInfo): string {
  return [frame.url, frame.name, frame.id, frame.title].filter(Boolean).join(' ')
}

export function detectChallenge(signals: ChallengeSignals): ChallengeVerdict {
  const evidence: string[] = []
  let kind: ChallengeKind | undefined
  let confidence = 0

  // 1) iframe 域名：最强证据
  for (const frame of signals.frames ?? []) {
    const haystack = frameText(frame)
    if (!haystack) continue
    for (const rule of FRAME_HOSTS) {
      if (rule.pattern.test(haystack)) {
        if (!kind) kind = rule.kind
        evidence.push(rule.label)
        confidence = Math.max(confidence, 0.9)
      }
    }
  }

  // 2) URL 路径
  const url = signals.url ?? ''
  for (const rule of URL_PATTERNS) {
    if (rule.pattern.test(url)) {
      if (!kind) kind = rule.kind
      evidence.push(rule.label)
      confidence = Math.max(confidence, 0.85)
    }
  }

  // 3) 文本/标题
  const text = `${signals.title ?? ''} ${signals.text ?? ''}`
  for (const rule of TEXT_PATTERNS) {
    if (rule.pattern.test(text)) {
      if (!kind || kind === 'unknown') kind = rule.kind
      evidence.push(rule.label)
      confidence = Math.max(confidence, rule.kind === 'slider' ? 0.75 : 0.7)
    }
  }

  if (evidence.length === 0) return NO_CHALLENGE

  // 滑块证据优先作为 kind（用户更需要知道"要拖一下"）
  if (evidence.some((entry) => entry === '滑块验证')) kind = 'slider'

  return {
    challenge: true,
    ...(kind ? { kind } : {}),
    evidence: [...new Set(evidence)].slice(0, 3).join('、'),
    confidence
  }
}

/** 置信度阈值：低于此值只提示、不强制暂停。 */
export const CHALLENGE_PAUSE_THRESHOLD = 0.75

export function shouldPauseAgent(verdict: ChallengeVerdict): boolean {
  return verdict.challenge && verdict.confidence >= CHALLENGE_PAUSE_THRESHOLD
}
