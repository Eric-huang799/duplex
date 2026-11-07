import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import './model-capability.css'

interface Props {
  baseUrl: string
  model: string
}

/**
 * 模型能力徽标：调用 `/api/show` 问一下这个模型到底支不支持工具调用、上下文多大。
 *
 * 存在的理由很具体——本地模型"不会用工具"最常见的原因就是**它根本没有 tools 能力**
 * （很多去审查微调会把函数调用一起磨掉），而这一点在界面上完全看不见，
 * 用户只能反复调参数。把事实摆出来，问题就只剩"换个模型"这一个答案。
 *
 * 非 Ollama 端点、探测失败、未配置模型时都不渲染任何东西。
 */
export function ModelCapability({ baseUrl, model }: Props): React.JSX.Element | null {
  const { t } = useI18n()
  const [info, setInfo] = useState<{ tools: boolean; contextLength: number | null } | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    let alive = true
    setChecked(false)
    setInfo(null)
    if (!baseUrl || !model) {
      setChecked(true)
      return () => {
        alive = false
      }
    }
    void window.cobrowse
      .probeProvider({ baseUrl, model })
      .then((result) => {
        if (!alive) return
        setInfo(result)
        setChecked(true)
      })
      .catch(() => {
        if (alive) setChecked(true)
      })
    return () => {
      alive = false
    }
  }, [baseUrl, model])

  if (!checked || !info) return null

  return (
    <div className={`model-cap ${info.tools ? 'ok' : 'bad'}`}>
      <span className="model-cap-dot" />
      {info.tools ? t('providers.cap.tools') : t('providers.cap.noTools')}
      {info.contextLength ? (
        <span className="model-cap-ctx">{t('providers.cap.context', { n: info.contextLength })}</span>
      ) : null}
    </div>
  )
}
