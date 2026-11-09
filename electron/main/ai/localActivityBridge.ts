import type { ChatMessage, ChatPhase, ChatSnapshot } from '../../../shared/chat'
import { isLocalOwnership, type AIOwnership } from '../../../shared/aiOwnership'

interface AvatarActivityTarget {
  setConversationState(phase: ChatPhase): void
  setTaskActivity(snapshot: ChatSnapshot): void
  setTaskOutcome(status: string | undefined): void
  clearTaskOwner?(): void
}

/** Only the active, explicitly owned local execution can drive the avatar. */
export class LocalActivityBridge {
  private owner?: AIOwnership
  private retired = new Set<string>()
  constructor(private target: () => AvatarActivityTarget | undefined, private activeSession: () => string) {}
  private authorized(owner: AIOwnership | undefined): owner is AIOwnership {
    return isLocalOwnership(owner) && owner.sessionId === this.activeSession()
  }
  private matches(owner: AIOwnership | undefined): boolean {
    return this.authorized(owner) && this.owner?.sessionId === owner.sessionId && this.owner.correlationId === owner.correlationId
  }
  private retire(owner: AIOwnership): void {
    this.retired.add(owner.correlationId)
    if (this.retired.size > 128) this.retired.delete(this.retired.values().next().value!)
  }
  /** Revoke an old surface lease when focus switches between local chat and the companion. */
  reset(): void {
    if (this.owner) this.retire(this.owner)
    this.owner = undefined
    const target = this.target()
    if (target?.clearTaskOwner) target.clearTaskOwner()
    else target?.setConversationState('idle')
  }
  phase(phase: ChatPhase, owner?: AIOwnership): void {
    if (!this.authorized(owner)) return
    if (phase !== 'idle') {
      if (this.retired.has(owner.correlationId)) return
      if (this.owner && this.owner.correlationId !== owner.correlationId) this.retire(this.owner)
      this.owner = owner
    }
    else if (!this.matches(owner)) return
    this.target()?.setConversationState(phase)
    if (phase === 'idle') {
      this.retire(owner)
    }
  }
  activity(snapshot: ChatSnapshot): void {
    if (this.matches(snapshot.ownership)) this.target()?.setTaskActivity(snapshot)
  }
  ended(message: ChatMessage): void {
    if (!this.matches(message.ownership)) return
    this.target()?.setTaskOutcome(message.status)
    this.retire(message.ownership!)
    this.owner = undefined
  }
}
