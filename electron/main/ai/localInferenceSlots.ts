import { ChatError } from './AIProvider'

/** One active desktop Ollama chat turn across Athena Chat and the floating companion. */
class LocalInferenceSlots {
  private active = false
  private waiters: Array<{ grant(): void; cancel(): void }> = []
  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (!this.active) { this.active = true; return Promise.resolve(() => this.release()) }
    return new Promise((resolve, reject) => {
      const item = {
        grant: () => { signal.removeEventListener('abort', item.cancel); resolve(() => this.release()) },
        cancel: () => { this.waiters = this.waiters.filter(entry => entry !== item); signal.removeEventListener('abort', item.cancel); reject(new ChatError('Local inference was cancelled while waiting for available memory.')) },
      }
      this.waiters.push(item)
      signal.addEventListener('abort', item.cancel, { once: true })
      if (signal.aborted) item.cancel()
    })
  }
  private release(): void {
    const next = this.waiters.shift()
    if (next) next.grant()
    else this.active = false
  }
}

export const localInferenceSlots = new LocalInferenceSlots()
