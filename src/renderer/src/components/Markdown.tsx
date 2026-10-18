import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useI18n } from '../i18n'

interface Props {
  text: string
}

/**
 * Markdown rendering for assistant replies in the side panel.
 * http(s) links always open in a new browser tab; non-web schemes (mailto: …)
 * never navigate and explain themselves via the title tooltip.
 */
export function MarkdownProse({ text }: Props): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const web = !!href && /^https?:/i.test(href)
            return (
              <a
                href={href}
                title={web ? href : t('markdown.linkUnavailable')}
                onClick={(e) => {
                  e.preventDefault()
                  if (web && href) {
                    void window.cobrowse.tabAction({ type: 'newTab', url: href })
                  }
                }}
              >
                {children}
              </a>
            )
          }
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
