import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings } from '../shared/settings'

const { dockBadge, setIcon, badgeCount, overlay, show, click } = vi.hoisted(() => ({ dockBadge: vi.fn(), setIcon: vi.fn(), badgeCount: vi.fn(() => false), overlay: vi.fn(), show: vi.fn(), click: vi.fn() }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/test', setBadgeCount: badgeCount, dock: { setBadge: dockBadge, setIcon } },
  nativeImage: { createFromBuffer: () => ({}), createFromPath: () => ({ isEmpty: () => false, toPNG: () => Buffer.from('icon') }) },
  Notification: class { static isSupported() { return true } on(event: string, handler: () => void) { if (event === 'click') click.mockImplementation(handler) } once() { return this } show() { show() } },
}))
vi.mock('@napi-rs/canvas', () => ({ createCanvas: () => ({ getContext: () => ({ beginPath() {}, arc() {}, fill() {}, fillText() {}, drawImage() {}, stroke() {} }), toBuffer: () => Buffer.from('') }), loadImage: async () => ({}) }))
import { TaskNotifications } from '../electron/main/ai/taskNotifications'

beforeEach(() => { vi.clearAllMocks() })
describe('background completion notification adapter', () => {
  it('updates the macOS Dock badge and opens only the clicked conversation', () => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const open = vi.fn()
      const notifications = new TaskNotifications(() => ({ setOverlayIcon: overlay, isDestroyed: () => false }) as never, () => defaultSettings, open)
      notifications.completed({ sessionId: 'conversation-a', title: 'Private title', executionId: 'execution-a', status: 'complete', unreadCount: 1 })
      notifications.completed({ sessionId: 'conversation-a', title: 'Private title', executionId: 'execution-a', status: 'complete', unreadCount: 1 })
      expect(dockBadge).toHaveBeenLastCalledWith('1')
      expect(show).toHaveBeenCalledTimes(1)
      click()
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ source: 'online', sessionId: 'conversation-a', approvalId: '' }))
      notifications.badge(0)
      expect(dockBadge).toHaveBeenLastCalledWith('')
    } finally { Object.defineProperty(process, 'platform', { value: platform }) }
  })

  it('draws a visible icon badge when macOS declines Electron badge-count delivery', async () => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const notifications = new TaskNotifications(() => undefined, () => defaultSettings, vi.fn())
      notifications.approval({ source: 'online', sessionId: 'session', title: 'Task', approvalId: 'approval-icon', action: 'required' })
      await new Promise(resolve => setImmediate(resolve))
      expect(badgeCount).toHaveBeenCalledWith(1)
      expect(setIcon).toHaveBeenCalledWith(expect.anything())
    } finally { Object.defineProperty(process, 'platform', { value: platform }) }
  })

  it('sets and clears a Windows taskbar overlay', () => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const notifications = new TaskNotifications(() => ({ setOverlayIcon: overlay, isDestroyed: () => false }) as never, () => defaultSettings, vi.fn())
      notifications.badge(2)
      expect(overlay).toHaveBeenCalledWith(expect.anything(), '2 unread task completions')
      notifications.badge(0)
      expect(overlay).toHaveBeenLastCalledWith(null, '')
    } finally { Object.defineProperty(process, 'platform', { value: platform }) }
  })

  it('deduplicates and restores pending local approvals, then reconciles stale entries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'athena-approval-ledger-'))
    try {
      const ledger = join(directory, 'approvals.json')
      const open = vi.fn()
      const first = new TaskNotifications(() => ({ setOverlayIcon: overlay, isDestroyed: () => false }) as never, () => defaultSettings, open, ledger)
      const event = { source: 'local' as const, sessionId: 'local-session', title: 'Local work', approvalId: 'approval-1', action: 'required' as const, summary: 'Review file changes' }
      first.approval(event); first.approval(event)
      expect(first.pendingCount()).toBe(1)
      expect(show).toHaveBeenCalledTimes(1)
      click()
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ source: 'local', sessionId: 'local-session', approvalId: 'approval-1' }))
      expect(first.pendingCount()).toBe(1)
      const restored = new TaskNotifications(() => ({ setOverlayIcon: overlay, isDestroyed: () => false }) as never, () => defaultSettings, open, ledger)
      restored.reconcile([{ approvalId: 'approval-1', source: 'local', sessionId: 'local-session', title: 'Local work', summary: 'Review file changes' }])
      expect(restored.pendingCount()).toBe(1)
      expect(show).toHaveBeenCalledTimes(1)
      restored.reconcile([])
      expect(restored.pendingCount()).toBe(0)
      expect(restored.approval({ ...event, action: 'resolved' })).toBeUndefined()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('keeps the approval badge above completion counts and restores completions after resolution', () => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const notices = new TaskNotifications(() => undefined, () => defaultSettings, vi.fn())
      notices.badge(4)
      notices.approval({ source: 'online', sessionId: 'session', title: 'Task', approvalId: 'approval-a', action: 'required' })
      notices.approval({ source: 'local', sessionId: 'local', title: 'Local task', approvalId: 'approval-b', action: 'required' })
      expect(dockBadge).toHaveBeenLastCalledWith('2')
      notices.approval({ source: 'online', sessionId: 'session', title: 'Task', approvalId: 'approval-a', action: 'resolved' })
      expect(dockBadge).toHaveBeenLastCalledWith('1')
      notices.approval({ source: 'local', sessionId: 'local', title: 'Local task', approvalId: 'approval-b', action: 'resolved' })
      expect(dockBadge).toHaveBeenLastCalledWith('4')
    } finally { Object.defineProperty(process, 'platform', { value: platform }) }
  })

  it('keeps pending state and badges when native alerts are disabled or suppressed by DND', () => {
    const settings = { ...defaultSettings, doNotDisturb: true, notificationPreferences: { ...defaultSettings.notificationPreferences }, backgroundTasks: { ...defaultSettings.backgroundTasks } }
    const notifications = new TaskNotifications(() => undefined, () => settings, vi.fn())
    const event = { source: 'local' as const, sessionId: 'local', title: 'Private local', approvalId: 'approval-dnd', action: 'required' as const }
    notifications.approval(event)
    expect(notifications.pendingCount()).toBe(1)
    expect(show).not.toHaveBeenCalled()
    settings.doNotDisturb = false
    settings.notificationPreferences.approvals = false
    notifications.settingsChanged()
    expect(notifications.pendingCount()).toBe(1)
    expect(show).not.toHaveBeenCalled()
    settings.notificationPreferences.approvals = true
    notifications.settingsChanged()
    expect(show).toHaveBeenCalledTimes(1)
  })
})
