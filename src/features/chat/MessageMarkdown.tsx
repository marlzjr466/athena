import { Children, isValidElement, memo, useEffect, useId, useState, type ReactNode } from 'react'
import { Check, Copy, Maximize2, Minimize2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { desktop } from '../../services/desktop'
import { ChatTooltip } from './ChatTooltip'
import { stripTrailingSourcesSection } from '../../../shared/chat'

export function CopyText({ text, label = 'Copy message', compact = false }: { text: string; label?: string; compact?: boolean }) {
  const [result, setResult] = useState('')
  return <span className="chat-copy"><ChatTooltip label={result === 'Copied' ? 'Copied' : label}><button type="button" className={`chat-action ${compact ? 'chat-icon-action' : ''}`} aria-label={label} onClick={() => {
    void desktop.copyChatText({ text }).then((response) => setResult(response.ok ? 'Copied' : 'Copy failed')).catch(() => setResult('Copy failed'))
  }}>{result === 'Copied' ? <Check size={16} strokeWidth={1.8} /> : <Copy size={16} strokeWidth={1.8} />}{!compact && <span>{label}</span>}</button></ChatTooltip><span role="status" className={compact ? 'chat-sr-only' : undefined}>{result}</span></span>
}
function plainText(node: ReactNode): string {
  return Children.toArray(node).map((child) => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? plainText(child.props.children) : '').join('')
}
let mermaidConfigured = false
function MermaidDiagram({ source }: { source: string }) {
  const id = `athena-mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [svg, setSvg] = useState(''), [failed, setFailed] = useState(false), [expanded, setExpanded] = useState(false)
  useEffect(() => {
    let current = true
    setSvg(''); setFailed(false)
    if (source.length > 20_000) { setFailed(true); return () => { current = false } }
    const timer = setTimeout(() => {
      void import('mermaid').then(async ({ default: mermaid }) => {
        if (!mermaidConfigured) {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', maxTextSize: 20_000, maxEdges: 200, suppressErrorRendering: true })
          mermaidConfigured = true
        }
        const result = await mermaid.render(id, source)
        if (current) setSvg(result.svg)
      }).catch(() => { if (current) setFailed(true) })
    }, 180)
    return () => { current = false; clearTimeout(timer) }
  }, [id, source])
  const viewBoxHeight = Number(/viewBox=["'][-\d.]+ [-\d.]+ [-\d.]+ ([-\d.]+)/.exec(svg)?.[1])
  const height = Number.isFinite(viewBoxHeight) && viewBoxHeight > 0 ? Math.min(480, Math.max(220, viewBoxHeight + 25)) : 340
  const document = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><style>html,body{margin:0;background:#202225;color:#eee;overflow:auto}svg{display:block;max-width:100%;height:auto;margin:auto}</style>${svg}`
  return <div className={`chat-mermaid ${expanded ? 'expanded' : ''}`}><div className="chat-code-toolbar"><span>mermaid</span><span className="chat-mermaid-actions"><CopyText text={source} label="Copy diagram source" /><ChatTooltip label={expanded ? 'Close expanded diagram' : 'Expand diagram'}><button type="button" className="chat-action chat-icon-action" aria-label={expanded ? 'Close expanded diagram' : 'Expand diagram'} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button></ChatTooltip></span></div>
    {svg ? <iframe title="Mermaid diagram" sandbox="" srcDoc={document} style={{ height: expanded ? 'calc(100vh - 140px)' : `${height}px` }} /> : failed ? <pre aria-label="Mermaid source (diagram unavailable)">{source}</pre> : <p role="status">Rendering diagram…</p>}
  </div>
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find((child) => isValidElement(child))
  const className = isValidElement<{ className?: string }>(code) ? code.props.className ?? '' : ''
  const language = /(?:^|\s)language-([\w+-]+)/.exec(className)?.[1] ?? 'text'
  if (language === 'mermaid') return <MermaidDiagram source={plainText(children)} />
  return <div className="chat-code"><div className="chat-code-toolbar"><span>{language}</span><CopyText text={plainText(children)} label="Copy code" /></div><pre tabIndex={0} aria-label={`${language} code`}>{children}</pre></div>
}
export const MessageMarkdown = memo(function MessageMarkdown({ content, stripSources = true }: { content: string; stripSources?: boolean }) {
  return <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false }]]} components={{
    // Model content cannot load remote resources, navigate, or execute HTML/code.
    img: ({ alt }) => <span className="chat-omitted-image">[Image omitted{alt ? `: ${alt}` : ''}]</span>,
    a: ({ href, children }) => {
      let host = ''
      try { const url = new URL(href ?? ''); if (url.protocol !== 'https:' && url.protocol !== 'http:') return <span>{children}</span>; host = url.hostname } catch { return <span>{children}</span> }
      return <button type="button" className="chat-link-text chat-source-link" aria-label={`Open source link ${host}`} onClick={() => { void desktop.openExternalLink({ url: href! }) }}>{children}<span className="chat-link-host"> ({host})</span></button>
    },
    pre: CodeBlock,
    table: ({ children }) => <div className="chat-table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table>{children}</table></div>,
  }}>{stripSources ? stripTrailingSourcesSection(content) : content}</ReactMarkdown>
})
