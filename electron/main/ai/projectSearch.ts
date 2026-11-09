import { runInNewContext } from 'node:vm'
import { ChatError } from './AIProvider'

export type SearchMode = 'exact' | 'symbol' | 'regex'
export function matchingLines(text: string, query: string, mode: SearchMode, caseSensitive: boolean, limit: number): number[] {
  // The pattern is data in a fixed program, never executable repository code.
  // A VM deadline bounds pathological regular expressions without blocking Electron indefinitely.
  try {
    return runInNewContext(`
      const matches = [];
      const needle = caseSensitive ? query : query.toLowerCase();
      const pattern = mode === 'regex' ? new RegExp(query, caseSensitive ? '' : 'i') : null;
      for (let i = 0; i < lines.length && matches.length < limit; i++) {
        const line = caseSensitive ? lines[i] : lines[i].toLowerCase();
        let found = pattern ? pattern.test(lines[i]) : line.includes(needle);
        if (found && mode === 'symbol') {
          found = false;
          let offset = line.indexOf(needle);
          while (offset >= 0) {
            const before = line[offset - 1] || '', after = line[offset + needle.length] || '';
            if (!/[\\w$]/.test(before) && !/[\\w$]/.test(after)) { found = true; break; }
            offset = line.indexOf(needle, offset + 1);
          }
        }
        if (found) matches.push(i);
      }
      matches;
    `, { lines: text.split('\n'), query, mode, caseSensitive, limit }, { timeout: 50, contextCodeGeneration: { strings: false, wasm: false } }) as number[]
  } catch { throw new ChatError('Search pattern is invalid or exceeded its execution deadline. Use a simpler expression or exact text.') }
}

export function globMatcher(pattern: string): (path: string) => boolean {
  // Dynamic programming avoids exponential regexp backtracking for model-supplied globs.
  const tokens: Array<{ type: 'literal' | 'star' | 'globstar' | 'directory' | 'any'; char?: string }> = []
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index].toLowerCase()
    if (char === '*' && pattern[index + 1] === '*') {
      index++
      if (pattern[index + 1] === '/') { index++; tokens.push({ type: 'directory' }) } else tokens.push({ type: 'globstar' })
    } else if (char === '*') tokens.push({ type: 'star' })
    else if (char === '?') tokens.push({ type: 'any' })
    else tokens.push({ type: 'literal', char })
  }
  return (path) => {
    const value = path.toLowerCase()
    let previous = new Uint8Array(value.length + 1); previous[0] = 1
    for (const token of tokens) {
      const next = new Uint8Array(value.length + 1)
      if (token.type === 'star' || token.type === 'globstar') {
        next[0] = previous[0]
        for (let index = 1; index <= value.length; index++) next[index] = previous[index] || ((token.type === 'globstar' || value[index - 1] !== '/') ? next[index - 1] : 0)
      } else if (token.type === 'directory') {
        let reachable = 0
        for (let index = 0; index <= value.length; index++) { reachable ||= previous[index]; next[index] = previous[index] || (index > 0 && value[index - 1] === '/' ? reachable : 0) }
      } else {
        for (let index = 1; index <= value.length; index++) next[index] = previous[index - 1] && (token.type === 'any' ? value[index - 1] !== '/' : token.char === value[index - 1]) ? 1 : 0
      }
      previous = next
    }
    return Boolean(previous[value.length])
  }
}
