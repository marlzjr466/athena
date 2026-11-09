const EXTENSIONS: Record<string, string> = {
  typescript: 'ts', ts: 'ts', tsx: 'tsx', javascript: 'js', js: 'js', jsx: 'jsx',
  python: 'py', py: 'py', java: 'java', sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yaml',
  xml: 'xml', html: 'html', css: 'css', markdown: 'md', md: 'md', csv: 'csv', log: 'log',
}

/** Infer a conservative filename for user-pasted text without changing its content. */
export function inferPastedTextName(text: string, existingNames: readonly string[] = []): string {
  const language = /```\s*([A-Za-z0-9_-]+)/.exec(text)?.[1]?.toLowerCase()
  let extension = language ? EXTENSIONS[language] : undefined
  if (!extension && /^\s*[\[{]/.test(text)) {
    try { JSON.parse(text); extension = 'json' } catch { /* It may be a code fragment rather than JSON. */ }
  }
  if (!extension && /(?:^|\n)\s*(?:ERROR|WARN|INFO)\b|\b(?:stack trace|exception|stderr|stdout)\b/i.test(text)) extension = 'log'
  if (!extension && /(?:^|\n)\s*(?:import|export|const|let|function|class|interface|def|SELECT|<\w+[^>]*>)/.test(text)) extension = 'txt'
  const base = extension && extension !== 'txt' ? 'Pasted code' : 'Pasted text'
  const suffix = extension ? `.${extension}` : '.txt'
  const used = new Set(existingNames.map((name) => name.toLowerCase()))
  const first = `${base}${suffix}`
  if (!used.has(first.toLowerCase())) return first
  for (let index = 2; index < 10_000; index++) {
    const candidate = `${base} (${index})${suffix}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${Date.now()}${suffix}`
}
