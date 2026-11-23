import { expect, it } from 'vitest'
import { ResponseAccumulator } from '../electron/main/ai/responseAccumulator'
it('preserves completed tool items when a sparse terminal snapshot reuses its index', () => {
  const accumulator = new ResponseAccumulator()
  accumulator.accept({ type: 'response.output_item.done', output_index: 0, item: { id: 'tool', type: 'function_call', call_id: 'call', name: 'read_file', arguments: '{}', status: 'completed' } } as never)
  accumulator.accept({ type: 'response.completed', response: { output: [{ id: 'answer', type: 'message', content: [] }] } } as never)
  expect(accumulator.output.map(item => item.id)).toEqual(['tool', 'answer'])
})
it('classifies malformed supported events before they become generic TypeErrors', () => {
  for (const event of [{ type: 'response.output_item.done' }, { type: 'response.completed', response: { output: {} } }, { type: 'response.completed', response: { output: [null] } }, { type: 'response.output_text.delta', delta: {} }]) {
    expect(() => new ResponseAccumulator().accept(event as never)).toThrow('malformed response event')
  }
})
