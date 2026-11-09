export type VoiceWebOpen = { kind: 'result'; index: number } | { kind: 'url'; url: string }

const websiteAliases: Array<[RegExp, string]> = [
  [/^(?:the )?(?:official )?github(?: website| site)?$/i, 'https://github.com/'],
  [/^(?:the )?(?:official )?react(?: website| site| documentation| docs)?$/i, 'https://react.dev/'],
]

/** Interpret only explicit browser requests. Unknown names stay with the AI. */
export function parseVoiceWebOpen(text: string): VoiceWebOpen | undefined {
  const result = /^(?:please )?(?:open|show(?: me)?|go to|navigate to)\s+(?:(?:the )?(first|second|third|fourth|fifth|\d+)(?:\s+(?:search\s+)?result)|(?:that|the)\s+(?:documentation|website|site|page)(?:\s+you\s+found)?)$/i.exec(text)
  if (result) {
    const index = ({ first: 1, second: 2, third: 3, fourth: 4, fifth: 5 } as Record<string, number>)[result[1]?.toLowerCase()] ?? Number(result[1] ?? 1)
    return { kind: 'result', index }
  }
  const literal = /^(?:please )?(?:open|go to|navigate to)\s+((?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?)$/i.exec(text)
  if (literal) return { kind: 'url', url: /^https?:\/\//i.test(literal[1]) ? literal[1] : `https://${literal[1]}` }
  const named = /^(?:please )?(?:open|go to|navigate to|show me)\s+(.+)$/i.exec(text)
  const known = named && websiteAliases.find(([pattern]) => pattern.test(named[1]))?.[1]
  return known ? { kind: 'url', url: known } : undefined
}
