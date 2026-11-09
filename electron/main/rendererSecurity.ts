export function matchesRendererURL(actual: string, expected: string | undefined): boolean {
  if (!expected) return false
  try {
    const candidate = new URL(actual), trusted = new URL(expected)
    // Hash navigation is internal UI state, not a different document. Origin
    // alone is insufficient for file: pages and for a development web server.
    candidate.hash = ''; trusted.hash = ''
    return candidate.href === trusted.href && ['athena:', 'file:', 'http:', 'https:'].includes(trusted.protocol)
  } catch { return false }
}
