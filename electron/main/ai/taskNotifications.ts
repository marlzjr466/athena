import { app, nativeImage, Notification, type BrowserWindow } from 'electron'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Settings } from '../../../shared/settings'

export type ApprovalRoute = { sessionId: string; title: string; approvalId: string; action: 'required' | 'resolved'; source?: 'online' | 'local' | 'companion'; projectId?: string; projectName?: string; taskId?: string; agentId?: string; summary?: string }
export interface TaskNotice { sessionId: string; title: string; executionId: string; status: 'complete' | 'failed'; unreadCount: number }
type PendingApproval = { approvalId: string; source: 'online' | 'local' | 'companion'; sessionId: string; title: string; summary: string; projectId?: string; projectName?: string; taskId?: string; agentId?: string; presentedAt?: number }
type Ledger = { version: 1; approvals: PendingApproval[]; resolved?: string[] }

/** Central native notifications and app badge; approval truth is reconciled from chat executions. */
export class TaskNotifications {
  private shown = new Set<string>()
  private completedCount = 0
  private approvals = new Map<string, PendingApproval>()
  private resolved = new Set<string>()
  private baseDockIcon?: Electron.NativeImage
  private dockIconRevision = 0
  constructor(private window: () => BrowserWindow | undefined, private settings: () => Settings, private open: (route: PendingApproval) => void, private ledgerPath?: string) {
    if (ledgerPath) try {
      if (existsSync(ledgerPath)) {
        const data = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger
        if (data.version === 1 && Array.isArray(data.approvals)) for (const entry of data.approvals) if (entry?.approvalId && entry?.sessionId) this.approvals.set(entry.approvalId, entry)
        if (Array.isArray(data.resolved)) this.resolved = new Set(data.resolved.filter(id => typeof id === 'string').slice(-1000))
      }
    } catch { this.approvals.clear() }
  }

  badge(count: number): void { this.completedCount = count; this.renderBadge() }
  settingsChanged(): void { this.renderBadge(); for (const entry of this.approvals.values()) if (!entry.presentedAt) this.present(entry) }
  private renderBadge(): void {
    const prefs = this.settings()
    const approvalCount = prefs.notificationPreferences.approvalBadges ? this.approvals.size : 0
    const visible = approvalCount || (prefs.backgroundTasks.badge ? this.completedCount : 0)
    if (process.platform === 'darwin') {
      let nativeBadgeApplied = false
      try { nativeBadgeApplied = app.setBadgeCount(visible) } catch { /* Dock icon fallback below remains available. */ }
      try { app.dock?.setBadge(visible ? (visible > 9 ? '9+' : String(visible)) : '') } catch { /* OS badge availability cannot affect execution. */ }
      // Electron's native Dock badge can be unavailable when macOS notification
      // authorization is off. Keep the app icon itself visibly badged in that
      // case; this remains independent of native notification preferences.
      void this.renderMacDockBadge(nativeBadgeApplied ? 0 : visible, approvalCount > 0)
    }
    if (process.platform !== 'win32') return
    const window = this.window()
    if (!window || window.isDestroyed()) return
    try {
      if (!visible) { window.setOverlayIcon(null, ''); return }
      const canvas = createCanvas(32, 32), context = canvas.getContext('2d')
      context.fillStyle = approvalCount ? '#f0a93b' : '#66dbe9'; context.beginPath(); context.arc(16, 16, 15, 0, 2 * Math.PI); context.fill()
      context.fillStyle = '#082031'; context.font = 'bold 16px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(visible > 9 ? '9+' : String(visible), 16, 17)
      window.setOverlayIcon(nativeImage.createFromBuffer(canvas.toBuffer('image/png')), approvalCount ? `${approvalCount} pending approvals` : `${visible} unread task completions`)
    } catch { /* Windows overlay is optional. */ }
  }
  private async renderMacDockBadge(count: number, approval: boolean): Promise<void> {
    const revision = ++this.dockIconRevision
    const dock = app.dock
    if (!dock) return
    try {
      if (!this.baseDockIcon) {
        const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.icns') : join(app.getAppPath(), 'build', 'icon.png')
        const icon = nativeImage.createFromPath(iconPath)
        if (icon.isEmpty()) return
        this.baseDockIcon = icon
      }
      if (revision !== this.dockIconRevision) return
      if (count <= 0) { dock.setIcon(this.baseDockIcon); return }
      const canvas = createCanvas(512, 512), context = canvas.getContext('2d')
      const source = await loadImage(this.baseDockIcon.toPNG())
      if (revision !== this.dockIconRevision) return
      context.drawImage(source, 0, 0, 512, 512)
      const label = count > 9 ? '9+' : String(count)
      context.beginPath(); context.arc(416, 96, 84, 0, 2 * Math.PI)
      context.fillStyle = approval ? '#f0a93b' : '#66dbe9'; context.fill()
      context.lineWidth = 12; context.strokeStyle = '#ffffff'; context.stroke()
      context.fillStyle = '#082031'; context.font = 'bold 104px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(label, 416, 99)
      if (revision === this.dockIconRevision) dock.setIcon(nativeImage.createFromBuffer(canvas.toBuffer('image/png')))
    } catch { /* Badge fallback must never affect the approval flow. */ }
  }
  private persist(): void {
    if (!this.ledgerPath) return
    try { mkdirSync(dirname(this.ledgerPath), { recursive: true }); const tmp = `${this.ledgerPath}.tmp`; writeFileSync(tmp, JSON.stringify({ version: 1, approvals: [...this.approvals.values()], resolved: [...this.resolved].slice(-1000) } satisfies Ledger), { mode: 0o600 }); renameSync(tmp, this.ledgerPath) } catch { /* Chat execution remains authoritative if ledger storage fails. */ }
  }
  private present(entry: PendingApproval): void {
    const prefs = this.settings(), notification = prefs.notificationPreferences
    if (!notification.approvals || !prefs.backgroundTasks.nativeNotifications || (notification.suppressDuringDnd && prefs.doNotDisturb) || !Notification.isSupported()) return
    try {
      const projectPrefix = entry.projectName ? `${entry.projectName} · ` : ''
      const body = notification.preview ? `${projectPrefix}${entry.title} · ${entry.summary}` : 'Athena is waiting for your approval.'
      const notice = new Notification({ title: 'Athena needs your approval', body: body.slice(0, 180), silent: !notification.sound })
      notice.on('click', () => this.open(entry)); notice.once('failed', () => { entry.presentedAt = undefined; this.persist() }); notice.show()
      entry.presentedAt = Date.now(); this.persist()
    } catch { /* OS permission denial leaves the in-app approval and badge intact. */ }
  }
  approval(event: ApprovalRoute): void {
    if (event.action === 'resolved') { this.resolved.add(event.approvalId); if (this.resolved.size > 1000) this.resolved.delete(this.resolved.values().next().value!); this.approvals.delete(event.approvalId); this.persist(); this.renderBadge(); return }
    if (this.resolved.has(event.approvalId)) return
    const source = event.source ?? 'online'
    const existing = this.approvals.get(event.approvalId)
    const entry: PendingApproval = { ...existing, approvalId: event.approvalId, source, sessionId: event.sessionId, title: event.title, summary: event.summary ?? 'An operation needs your review.', projectId: event.projectId, projectName: event.projectName, taskId: event.taskId, agentId: event.agentId, presentedAt: existing?.presentedAt }
    if (existing) { this.approvals.set(event.approvalId, entry); this.persist(); this.renderBadge(); return }
    this.approvals.set(event.approvalId, entry); this.persist(); this.renderBadge(); this.present(entry)
  }
  reconcile(actual: PendingApproval[]): void {
    const truth = new Map(actual.map(entry => [entry.approvalId, entry]))
    for (const id of truth.keys()) this.resolved.delete(id)
    for (const id of this.approvals.keys()) if (!truth.has(id)) { this.approvals.delete(id); this.resolved.add(id) }
    for (const entry of actual) {
      const prior = this.approvals.get(entry.approvalId)
      this.approvals.set(entry.approvalId, { ...entry, presentedAt: prior?.presentedAt })
    }
    this.persist(); this.renderBadge()
    for (const entry of this.approvals.values()) if (!entry.presentedAt) this.present(entry)
  }
  pendingCount(): number { return this.approvals.size }
  completed(event: TaskNotice): void {
    this.badge(event.unreadCount)
    if (this.shown.has(event.executionId)) return
    this.shown.add(event.executionId); if (this.shown.size > 500) this.shown.delete(this.shown.values().next().value!)
    const prefs = this.settings().backgroundTasks
    if (!prefs.nativeNotifications || (event.status === 'complete' ? !prefs.notifyComplete : !prefs.notifyFailed) || !Notification.isSupported()) return
    try { const notice = new Notification({ title: event.status === 'complete' ? 'Athena — Task completed' : 'Athena — Task needs attention', body: `A background conversation ${event.status === 'complete' ? 'finished' : 'needs your attention'}.`, silent: true }); notice.on('click', () => this.open({ source: 'online', sessionId: event.sessionId, title: event.title, approvalId: '', summary: '' })); notice.show() } catch { /* Notification delivery cannot fail task completion. */ }
  }
}
