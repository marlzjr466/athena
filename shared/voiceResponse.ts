import { modelCapabilities, type ReasoningEffort } from './conversations'

/** A conservative, local classifier: no extra AI request is spent choosing voice effort. */
export function voiceReasoningEffort(text: string, model: string | null, selected: ReasoningEffort, adaptive: boolean): ReasoningEffort {
  const supported = modelCapabilities(model).efforts
  if (!adaptive || selected === 'xhigh') return supported.includes(selected) ? selected : 'auto'
  const request = text.trim().toLowerCase()
  const desired: ReasoningEffort = /\b(?:exhaustive (?:analysis|proof|reasoning)|prove rigorously|extra high reasoning)\b/.test(request)
    ? 'xhigh'
    : /^(?:hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening)|how are you|tell me a joke)[!?.\s]*$/.test(request)
    ? 'low'
    : /\b(?:implement|refactor|debug|investigate|design|prove|analyze|compare|research|build|fix the|write code|plan a)\b/.test(request)
      ? 'high' : 'medium'
  return supported.includes(desired) ? desired : supported.includes(selected) ? selected : 'auto'
}

/** Buffers provider text only until a natural, speakable boundary is stable. */
export class VoiceSentenceBuffer {
  private pending = ''
  private spokenCharacters = 0
  private sourcesReached = false
  constructor(private readonly limit = 3600) {}

  push(delta: string): string[] {
    if (this.sourcesReached || this.spokenCharacters >= this.limit) return []
    this.pending += delta
    const sources = /\n\nSources:(?:\s|$)/i.exec(this.pending)
    if (sources) { this.pending = this.pending.slice(0, sources.index); this.sourcesReached = true }
    const ready: string[] = []
    while (this.pending.length && this.spokenCharacters < this.limit) {
      const sentence = /[.!?](?=\s|$)/.exec(this.pending)
      const phrase = /[,;:](?=\s)/.exec(this.pending)
      let end = sentence && sentence.index >= 12 ? sentence.index + 1 : -1
      if (end < 0 && phrase && phrase.index >= 30) end = phrase.index + 1
      if (end < 0 && this.pending.length >= 180) end = this.pending.lastIndexOf(' ', 165)
      if (end <= 0) break
      const part = this.pending.slice(0, end).trim().slice(0, this.limit - this.spokenCharacters)
      this.pending = this.pending.slice(end).trimStart()
      if (part) { ready.push(part); this.spokenCharacters += part.length }
    }
    return ready
  }

  flush(): string[] {
    const remaining = this.pending.trim().slice(0, this.limit - this.spokenCharacters)
    this.pending = ''
    if (remaining) { this.spokenCharacters += remaining.length; return [remaining] }
    return []
  }
}

/** One bounded, cancellable consumer keeps Chatterbox synthesis and playback in order. */
export class VoiceSegmentQueue {
  private segments: string[] = []
  private waiter?: (value: string | undefined) => void
  private ended = false
  push(segment: string): void {
    if (this.ended || !segment) return
    if (this.segments.length >= 40) { this.segments[this.segments.length - 1] += ` ${segment}`; return }
    if (this.waiter) { const resolve = this.waiter; this.waiter = undefined; resolve(segment) }
    else this.segments.push(segment)
  }
  async take(): Promise<string | undefined> {
    if (this.segments.length) {
      let next = this.segments.shift()!
      while (this.segments.length && next.length + this.segments[0].length < 220) next += ` ${this.segments.shift()}`
      return next
    }
    if (this.ended) return undefined
    return new Promise((resolve) => { this.waiter = resolve })
  }
  finish(): void { this.ended = true; if (!this.segments.length) { this.waiter?.(undefined); this.waiter = undefined } }
  cancel(): void { this.segments = []; this.ended = true; this.waiter?.(undefined); this.waiter = undefined }
}
