import { ACTION_DEFINITIONS, chooseIdleAction, type IdleActionId, type IdleActionSession } from '../../shared/idleActions'
import type { Settings } from '../../shared/settings'

interface ActionHooks {
  settings(): Settings
  eligible(): boolean
  changed(action: IdleActionSession | null): void
}
export class IdleActionController {
  private timer?: ReturnType<typeof setTimeout>
  private previous: IdleActionId | null = null
  private disposed = false
  current: IdleActionSession | null = null
  constructor(private hooks: ActionHooks) {}
  private canAct(): boolean {
    const settings = this.hooks.settings()
    return !this.disposed && settings.randomActions && settings.enabledActions.length > 0 && this.hooks.eligible()
  }
  reconcile(): void {
    if (!this.canAct() || (this.current && !this.hooks.settings().enabledActions.includes(this.current.id))) { this.cancel(); return }
    if (this.timer || this.current) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.canAct()) return
      const id = chooseIdleAction(this.hooks.settings().enabledActions, this.previous)
      if (!id) return
      this.previous = id
      this.current = { id, startedAt: Date.now(), durationMs: ACTION_DEFINITIONS[id].durationMs }
      this.hooks.changed(this.current)
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.current = null
        this.hooks.changed(null)
        this.reconcile()
      }, this.current.durationMs)
    }, this.hooks.settings().actionIntervalSeconds * 1000)
  }
  cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.current) { this.current = null; this.hooks.changed(null) }
  }
  restart(): void { this.cancel(); this.reconcile() }
  dispose(): void { this.disposed = true; this.cancel() }
}
