import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  text: string
}

/**
 * Markdown rendering for assistant replies in the side panel.
 * Links open as browser tabs (never navigate the app UI away).
 */
export function MarkdownProse({ text }: Props): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                if (href && /^https?:/i.test(href)) {
                  void window.cobrowse.tabAction({ type: 'navigate', url: href })
                }
              }}
            >
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
