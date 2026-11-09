// Preserve both the beginning and diagnostic tail, prioritizing error locations
// in long command logs. Full bounded output remains in private activity storage.
export function summarizeLog(text: string, max: number): string {
  if (text.length <= max) return text
  const errors = text.split('\n').filter((line) => /error|failed|failure|exception|\bTS\d{4}\b|\bat .+:\d+|test suites?:/i.test(line)).join('\n').slice(0, Math.floor(max / 2))
  const room = Math.max(0, max - errors.length - 120)
  return `${text.slice(0, Math.floor(room / 3))}\n[Log shortened; relevant diagnostics follow]\n${errors}\n[Final output]\n${text.slice(-Math.floor(room * 2 / 3))}`
}
export function limitToolOutput(text: string, max: number): string {
  if (text.length <= max) return text
  // Preserve a valid envelope even if the original result is JSON.
  let budget = Math.floor(max / 2) - 200
  for (;;) {
    const encoded = JSON.stringify({ truncated: true, notice: 'Output shortened. Request narrower file ranges/searches for additional evidence.', excerpt: summarizeLog(text, budget) })
    if (encoded.length <= max) return encoded
    budget = Math.floor(budget / 2)
  }
}
