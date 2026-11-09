import { randomUUID } from 'node:crypto'
import { aiOwnershipSchema, type AIOwnership } from '../../../shared/aiOwnership'

/** A main-issued lease binds floating voice events to one local conversation/configuration. */
export class LocalVoiceOwnership {
  private lease?: AIOwnership
  private configuration?: string
  constructor(private session: () => string | undefined, private config: () => string) {}
  acquire(): AIOwnership | undefined {
    const sessionId = this.session()
    if (!sessionId) return undefined
    this.configuration = this.config()
    this.lease = { origin: 'athena-local', sessionId, correlationId: randomUUID() }
    return { ...this.lease }
  }
  accepts(input: unknown): boolean {
    const parsed = aiOwnershipSchema.safeParse(input)
    const owner = parsed.success ? parsed.data : undefined
    return Boolean(owner && this.lease && owner.origin === 'athena-local'
      && owner.sessionId === this.session() && owner.sessionId === this.lease.sessionId
      && owner.correlationId === this.lease.correlationId && this.configuration === this.config())
  }
  /** A retiring renderer may release its own lease, but never a newer one. */
  release(input: unknown): boolean {
    const parsed = aiOwnershipSchema.safeParse(input)
    const owner = parsed.success ? parsed.data : undefined
    if (!owner || !this.lease || owner.origin !== 'athena-local'
      || owner.sessionId !== this.lease.sessionId || owner.correlationId !== this.lease.correlationId) return false
    this.clear()
    return true
  }
  clear(): void { this.lease = undefined; this.configuration = undefined }
}
