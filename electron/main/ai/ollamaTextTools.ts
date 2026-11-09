import { ChatError } from './AIProvider'

export interface TextToolCall { function: { name: string; arguments: Record<string, unknown> } }

const malformed = () => new ChatError('The local model returned a malformed tool request. No action was executed.')

/** Qwen’s Ollama template asks for tool JSON in the assistant text. Some builds
 * leave that JSON in `message.content` and never fill `message.tool_calls`.
 * Accept one complete tool request, including a single fenced call after a
 * short explanation. Do not execute a call buried among several examples. */
export function textToolCalls(text: string, names: readonly string[]): TextToolCall[] {
  const allowed = new Set(names)
  const tagged = text.includes('<tool_call>') || text.includes('</tool_call>')
  const blocks = tagged ? taggedBlocks(text) : untaggedBlock(text)
  if (!blocks.length) return []
  if (blocks.length > 20) throw malformed()
  return blocks.map((block) => {
    const call = readCall(block, tagged)
    if (!call || !allowed.has(call.name)) throw malformed()
    return { function: { name: call.name, arguments: call.arguments } }
  })
}

function taggedBlocks(text: string): string[] {
  const opens = text.match(/<tool_call>/g)?.length ?? 0
  const closes = text.match(/<\/tool_call>/g)?.length ?? 0
  const blocks = [...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].map((match) => match[1])
  if (opens !== closes || opens !== blocks.length) throw new ChatError('The local model mixed a tool request with other text. No action was executed.')
  if (blocks.length === 1) return blocks
  if (!/^\s*(?:<tool_call>[\s\S]*?<\/tool_call>\s*)+$/.test(text)) throw new ChatError('The local model mixed a tool request with other text. No action was executed.')
  return blocks
}

function untaggedBlock(text: string): string[] {
  const whole = wholeJsonBlock(text.trim())
  if (whole) return whole
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n```/g)].map((match) => match[1].trim()).filter((block) => block.startsWith('{'))
  if (fences.length !== 1) return []
  return readCall(fences[0], false) ? [fences[0]] : []
}

function wholeJsonBlock(candidate: string): string[] | null {
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(candidate)
  if (fence) candidate = fence[1].trim()
  if (!candidate.startsWith('{')) return null
  return readCall(candidate, false) ? [candidate] : []
}

function readCall(raw: string, strict: boolean): { name: string; arguments: Record<string, unknown> } | null {
  let value: unknown
  try { value = parseUniqueJson(raw) } catch (error) {
    if (error instanceof Error && error.message === 'duplicate') throw malformed()
    if (strict) throw malformed()
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) { if (strict) throw malformed(); return null }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const shaped = keys.includes('name') && keys.includes('arguments')
  if (!shaped) { if (strict) throw malformed(); return null }
  if (keys.length !== 2 || typeof record.name !== 'string' || !record.name || !isPlainObject(record.arguments)) throw malformed()
  return { name: record.name, arguments: record.arguments }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseUniqueJson(raw: string): unknown {
  let index = 0
  const skip = () => { while (index < raw.length && raw[index] <= ' ') index++ }
  function fail(): never { throw new SyntaxError('Invalid tool JSON') }
  const parseString = (): string => {
    if (raw[index] !== '"') fail()
    index++
    let value = ''
    while (index < raw.length) {
      const character = raw[index++]
      if (character === '"') return value
      if (character === '\\') {
        const escaped = raw[index++]
        if (escaped === 'u') {
          const hex = raw.slice(index, index + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail()
          value += String.fromCharCode(Number.parseInt(hex, 16))
          index += 4
        } else if (escaped === '"' || escaped === '\\' || escaped === '/') value += escaped
        else if (escaped === 'b') value += '\b'
        else if (escaped === 'f') value += '\f'
        else if (escaped === 'n') value += '\n'
        else if (escaped === 'r') value += '\r'
        else if (escaped === 't') value += '\t'
        else fail()
      } else if (character < ' ') fail()
      else value += character
    }
    fail()
  }
  const parse = (): unknown => {
    skip()
    const character = raw[index]
    if (character === '"') return parseString()
    if (character === '{') {
      index++
      const object: Record<string, unknown> = {}
      skip()
      if (raw[index] === '}') { index++; return object }
      for (;;) {
        skip()
        const key = parseString()
        if (Object.hasOwn(object, key)) throw new Error('duplicate')
        skip()
        if (raw[index++] !== ':') fail()
        object[key] = parse()
        skip()
        if (raw[index] === ',') { index++; continue }
        if (raw[index] === '}') { index++; return object }
        fail()
      }
    }
    if (character === '[') {
      index++
      const list: unknown[] = []
      skip()
      if (raw[index] === ']') { index++; return list }
      for (;;) {
        list.push(parse())
        skip()
        if (raw[index] === ',') { index++; continue }
        if (raw[index] === ']') { index++; return list }
        fail()
      }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(index))
    if (!literal) fail()
    index += literal[0].length
    return JSON.parse(literal[0])
  }
  const value = parse()
  skip()
  if (index !== raw.length) fail()
  return value
}
