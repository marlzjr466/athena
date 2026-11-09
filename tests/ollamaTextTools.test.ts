import { describe, expect, it } from 'vitest'
import { textToolCalls } from '../electron/main/ai/ollamaTextTools'
import { prepareLocalToolInput } from '../electron/main/ai/mlxProjectTools'

const names = ['read_file']
const call = { name: 'read_file', arguments: { path: 'src/main.tsx' } }
const raw = JSON.stringify(call)

describe('Ollama text tool calls', () => {
  it('accepts a complete JSON tool request in the forms Qwen actually emits', () => {
    const explained = 'The list_directory tool does not require depth.\n\n```json\n' + raw + '\n```'
    for (const text of [raw, '```json\n' + raw + '\n```', explained, `<tool_call>\n${raw}\n</tool_call>`, `Let me list the directory.\n<tool_call>${raw}</tool_call>`, `<tool_call>${raw}</tool_call><tool_call>${raw}</tool_call>`]) {
      const parsed = textToolCalls(text, names)
      expect(parsed.every((entry) => entry.function.name === 'read_file' && entry.function.arguments.path === 'src/main.tsx')).toBe(true)
    }
    expect(textToolCalls(`<tool_call>${raw}</tool_call><tool_call>${raw}</tool_call>`, names)).toHaveLength(2)
    expect(textToolCalls(explained, names)).toHaveLength(1)
  })

  it('ignores prose and broken JSON, and rejects ambiguous tool markup', () => {
    expect(textToolCalls(`I read the file. ${raw}`, names)).toEqual([])
    expect(textToolCalls('{broken', names)).toEqual([])
    expect(textToolCalls('{"summary":"done"}', names)).toEqual([])
    expect(textToolCalls('```json\n' + raw + '\n```\n```json\n' + raw + '\n```', names)).toEqual([])
    for (const text of [
      `<tool_call>${raw}</tool_call><tool_call>`,
      JSON.stringify({ name: 'write_file', arguments: {} }),
      JSON.stringify({ name: 'read_file', arguments: [] }),
      JSON.stringify({ name: 'read_file', arguments: {}, execute: true }),
      '{"name":"read_file","name":"read_file","arguments":{}}',
    ]) expect(() => textToolCalls(text, names)).toThrow(/No action was executed/)
  })
})

describe('local tool argument cleanup', () => {
  const definitions = [
    { name: 'list_directory', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' } }, required: ['path', 'offset'] } },
    { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } } } },
  ]
  it('drops undeclared fields, defaults offset, and stops placeholder paths', () => {
    expect(prepareLocalToolInput(definitions, 'list_directory', { path: '.claude/commands', depth: 2 })).toEqual({ input: { path: '.claude/commands', offset: 0 } })
    expect(prepareLocalToolInput(definitions, 'read_file', { path: 'path/to/your/project/claude/commands/platform-dev.md', start_line: 1, end_line: 40, depth: 1 })).toMatchObject({ error: expect.stringContaining('example placeholder') })
    expect(prepareLocalToolInput(definitions, 'read_file', { path: 'skills/platform-dev/SKILL.md', start_line: 1, end_line: 40 })).toEqual({ input: { path: 'skills/platform-dev/SKILL.md', start_line: 1, end_line: 40 } })
  })
})
