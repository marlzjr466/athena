/** Convert an inert clipboard HTML fragment into the Markdown stored by chat. */
export function clipboardHtmlToMarkdown(html: string): string {
  if (!/<[a-z][\s\S]*?>/i.test(html) || typeof DOMParser === 'undefined') return ''
  const document = new DOMParser().parseFromString(html, 'text/html')
  const ignored = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SVG', 'IMG', 'META', 'LINK'])
  const escapeText = (value: string) => value.replace(/\s+/g, ' ').replace(/([\\`*_{}\[\]<>|~])/g, '\\$1')
  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '')
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const element = node as Element
    if (ignored.has(element.tagName)) return ''
    if (element.tagName === 'BR') return '  \n'
    const content = Array.from(element.childNodes, inline).join('')
    if (element.tagName === 'STRONG' || element.tagName === 'B') return content.trim() ? `**${content.trim()}**` : ''
    if (element.tagName === 'EM' || element.tagName === 'I') return content.trim() ? `*${content.trim()}*` : ''
    if (element.tagName === 'CODE') return `\`${(element.textContent ?? '').replace(/`/g, '\\`')}\``
    if (element.tagName === 'A') {
      try {
        const url = new URL(element.getAttribute('href') ?? '')
        if (['https:', 'http:'].includes(url.protocol)) return `[${content.trim() || url.hostname}](${url.href.replace(/\)/g, '%29')})`
      } catch { /* An unsafe or relative link is text only. */ }
    }
    return content
  }
  const blocks = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
  const renderList = (element: Element, depth = 0): string => {
    const ordered = element.tagName === 'OL'
    const start = Number(element.getAttribute('start')) || 1
    return Array.from(element.children).filter(child => child.tagName === 'LI').map((child, index) => {
      const body = Array.from(child.childNodes).filter(node => node.nodeType !== Node.ELEMENT_NODE || !['UL', 'OL'].includes((node as Element).tagName))
      const label = body.map(inline).join('').trim().replace(/\n/g, '\n' + '  '.repeat(depth + 1))
      const nested = Array.from(child.children).filter(node => ['UL', 'OL'].includes(node.tagName)).map(node => renderList(node, depth + 1)).join('\n')
      return `${'  '.repeat(depth)}${ordered ? `${start + index}.` : '-'} ${label}${nested ? `\n${nested}` : ''}`
    }).join('\n')
  }
  const renderBlock = (element: Element): string => {
    if (ignored.has(element.tagName)) return ''
    if (element.tagName === 'UL' || element.tagName === 'OL') return renderList(element)
    if (element.tagName === 'PRE') {
      const code = element.textContent?.replace(/\n$/, '') ?? ''
      const fence = '`'.repeat(Math.max(3, (code.match(/`+/g) ?? []).reduce((max, part) => Math.max(max, part.length + 1), 3)))
      return `${fence}\n${code}\n${fence}`
    }
    if (/^H[1-6]$/.test(element.tagName)) return `${'#'.repeat(Number(element.tagName[1]))} ${Array.from(element.childNodes, inline).join('').trim()}`
    if (element.tagName === 'BLOCKQUOTE') return renderChildren(element).split('\n').map(line => `> ${line}`).join('\n')
    if (element.tagName === 'TABLE') {
      const rows = Array.from(element.querySelectorAll('tr')).map(row => Array.from(row.children).filter(cell => ['TH', 'TD'].includes(cell.tagName)).map(cell => Array.from(cell.childNodes, inline).join('').trim())).filter(row => row.length)
      if (!rows.length) return ''
      const width = Math.max(...rows.map(row => row.length))
      const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`
      return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')
    }
    return renderChildren(element)
  }
  const renderChildren = (parent: Element): string => {
    const output: string[] = []
    let pending = ''
    const flush = () => { if (pending.trim()) output.push(pending.trim()); pending = '' }
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE && blocks.has((node as Element).tagName)) {
        flush()
        const rendered = renderBlock(node as Element)
        if (rendered.trim()) output.push(rendered.trim())
      } else pending += inline(node)
    }
    flush()
    return output.join('\n\n')
  }
  return renderChildren(document.body).trim()
}
