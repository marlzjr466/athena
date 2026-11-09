import type { Response, ResponseOutputItem, ResponseStreamEvent } from 'openai/resources/responses/responses'
import { visibleOutputText } from './outputRecovery'

/** Retain completed SSE items even when the terminal event is a sparse snapshot.
 * Never turn reasoning text into an answer or execute items before completion. */
export class ResponseAccumulator {
  private items = new Map<number, ResponseOutputItem>()
  private parts = new Map<string, string>()
  readonly doneIds = new Set<string>()
  private emitted = ''
  terminal?: Response

  accept(event: ResponseStreamEvent): string {
    if (event.type === 'response.output_item.done') {
      if (event.item.type) this.items.set(event.output_index ?? this.items.size, event.item)
      if (event.item.id) this.doneIds.add(event.item.id)
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      const key = `${event.output_index ?? 0}:${event.content_index ?? 0}`
      this.parts.set(key, (this.parts.get(key) ?? '') + event.delta)
      this.emitted += event.delta
      return event.delta
    } else if (event.type === 'response.output_text.done' || event.type === 'response.refusal.done') {
      const key = `${event.output_index ?? 0}:${event.content_index ?? 0}`
      const text = event.type === 'response.output_text.done' ? event.text : event.refusal
      const previous = this.parts.get(key) ?? ''
      if (text.startsWith(previous)) {
        const rest = text.slice(previous.length)
        this.parts.set(key, text); this.emitted += rest
        return rest
      }
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      this.terminal = event.response
    }
    return ''
  }

  get output(): ResponseOutputItem[] {
    const terminal = this.terminal?.output ?? []
    if (!this.items.size) return terminal
    const merged = new Map(this.items)
    terminal.forEach((item, index) => {
      const existingIndex = [...merged].find(([, existing]) => existing.id === item.id)?.[0]
      // Completed item events have the final function arguments/encrypted state.
      if (existingIndex === undefined) merged.set(index, item)
    })
    return [...merged].sort(([a], [b]) => a - b).map(([, item]) => item)
  }

  get text(): string { return visibleOutputText(this.output) || this.emitted }
  remainingText(): string {
    const text = this.text
    return text.startsWith(this.emitted) ? text.slice(this.emitted.length) : ''
  }
}
