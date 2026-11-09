import { ChatError } from './AIProvider'

/** Serializes commands for the same canonical project root. Different roots run independently. */
class ProjectCommandLease {
  private readonly owners = new Set<string>()
  private readonly waiters = new Map<string, Array<{ grant(): void; cancel(): void }>>()

  acquire(root: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (!this.owners.has(root)) { this.owners.add(root); return Promise.resolve(() => this.release(root)) }
    return new Promise((resolve, reject) => {
      const queue = this.waiters.get(root) ?? []
      const item = {
        grant: () => { signal.removeEventListener('abort', item.cancel); resolve(() => this.release(root)) },
        cancel: () => {
          const index = queue.indexOf(item)
          if (index >= 0) queue.splice(index, 1)
          signal.removeEventListener('abort', item.cancel)
          reject(new ChatError('Project command cancelled while waiting for another command in the same project.'))
        },
      }
      queue.push(item); this.waiters.set(root, queue)
      signal.addEventListener('abort', item.cancel, { once: true })
      if (signal.aborted) item.cancel()
    })
  }

  private release(root: string): void {
    const queue = this.waiters.get(root)
    const next = queue?.shift()
    if (next) { next.grant(); if (!queue?.length) this.waiters.delete(root) }
    else { this.owners.delete(root); this.waiters.delete(root) }
  }
}

export const projectCommandLease = new ProjectCommandLease()
