import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { taskHologramLayout } from '../shared/taskHologramLayout'
import { currentTaskActivity, taskScreenTitle, taskVisualModeForActivity, taskVisualModeForStatus } from '../shared/taskActivity'
import { emptyChatSnapshot } from '../shared/chat'
import { TaskHolograms } from '../src/features/floating/TaskHolograms'
import { taskGesture } from '../src/three/AthenaAnimations'
import { curvedScreenGeometry } from '../src/three/TaskWorkScreen'
import type { TaskVisualMode } from '../shared/contracts'

describe('task activity presentation', () => {
  it.each([['read_file', 'reading'], ['search_content', 'searching'], ['apply_patch', 'typing'], ['create_file', 'typing'], ['delete_file', 'typing'], ['run_tests', 'terminal'], ['browser_verify', 'browser'], ['list_directory', 'exploring']])('maps %s to %s', (tool, expected) => {
    expect(taskVisualModeForActivity(tool, '')).toBe(expected)
  })
  it('does not reuse a completed reply or a completed tool as current work', () => {
    const snapshot = emptyChatSnapshot()
    snapshot.phase = 'thinking'
    snapshot.messages = [{ id: 'old', role: 'assistant', status: 'complete', content: '', createdAt: 0, execution: { startedAt: 0, updatedAt: 0, status: 'complete', activities: [{ id: 'read', tool: 'read_file', label: 'Read old file', status: 'running', startedAt: 0 }] } }]
    expect(currentTaskActivity(snapshot).type).toBe('assistant')
    snapshot.messages[0].status = 'streaming'
    expect(currentTaskActivity(snapshot).mode).toBe('reading')
    snapshot.messages[0].execution!.activities[0].status = 'complete'
    snapshot.phase = 'speaking'
    expect(currentTaskActivity(snapshot).label).toBe('Writing a response')
  })
  it('keeps destructive operations and outcomes accurately named', () => {
    expect(taskScreenTitle('typing', 'delete_file')).toBe('Delete')
    expect(taskScreenTitle('typing', 'create_file')).toBe('Create')
    expect(taskScreenTitle('terminal', 'run_tests')).toBe('Verify')
    expect(taskScreenTitle('browser', 'browser_verify')).toBe('Verify')
    expect(taskVisualModeForStatus('error')).toBe('failed')
    expect(taskVisualModeForStatus('stopped')).toBe('cancelled')
  })
  it.each([120, 180, 280])('mirrors the %ipx-avatar working perspective inward without moving its anchor', (size) => {
    const viewport = { width: Math.max(200, Math.round(size * 1.6)), height: Math.max(200, Math.round(size * 1.7)) }
    for (const x of [size / 2, viewport.width / 2, viewport.width - size / 2]) for (const y of [size / 2, viewport.height / 2, viewport.height - size / 2]) {
      const { yaw, screenY } = taskHologramLayout({ x, y }, viewport, size)
      expect(Math.cos(yaw)).toBeLessThan(-.7)
      expect(Math.sin(yaw)).toBe(x > viewport.width / 2 + size * .075 ? Math.sin(-2.4) : Math.sin(2.4))
      expect(screenY).toBeGreaterThanOrEqual(.28)
      expect(screenY).toBeLessThanOrEqual(.58)
    }
  })
  it('turns both hands inward toward the single screen and respects reduced motion and intensity', () => {
    const right = taskGesture('terminal', { x: 0, y: -1 }, 1, .65, false)
    const left = taskGesture('terminal', { x: 0, y: -1 }, 2, .65, false)
    expect(right.rightZ).toBeLessThan(.2)
    expect(right.leftZ).toBeGreaterThan(-.2)
    expect(right.rightX).toBeLessThan(0)
    expect(left.rightZ).not.toBe(right.rightZ)
    expect(taskGesture('terminal', { x: 1, y: 0 }, 1, .65, true)).toEqual(taskGesture('terminal', { x: 1, y: 0 }, 5, .65, true))
    expect(taskGesture('terminal', { x: 1, y: 0 }, 1, 0, false).rightZ).toBe(.2)
  })
  it('bows the sole 3D screen toward Athena and keeps the edges farther away', () => {
    const geometry = curvedScreenGeometry()
    const positions = geometry.attributes.position
    const left = positions.getZ(0)
    const center = positions.getZ(16)
    const right = positions.getZ(32)
    expect(center).toBeGreaterThan(left)
    expect(center).toBeGreaterThan(right)
    geometry.dispose()
  })
  it('updates the current screen status without remounting it and hides animation when not visible', () => {
    const props = { enabled: true, completionEnabled: true, reduced: false, characterSize: 120, active: true }
    const task = { mode: 'terminal' as TaskVisualMode, anchor: { x: 200, y: 150 }, activityType: 'run_tests', label: 'Running tests' }
    const view = render(<TaskHolograms {...props} task={task} />)
    const first = view.getByRole('status')
    expect(view.getByRole('status')).toHaveAttribute('aria-label', 'Athena working: Verify')
    view.rerender(<TaskHolograms {...props} task={{ ...task, mode: 'reading', activityType: 'read_file' }} />)
    expect(view.getByRole('status')).toBe(first)
    expect(first).toHaveAttribute('data-screen', 'read')
    view.rerender(<TaskHolograms {...props} active={false} task={task} />)
    expect(view.container.firstChild).toHaveClass('is-hidden')
    view.rerender(<TaskHolograms {...props} task={{ ...task, mode: 'failed' }} />)
    expect(view.getByRole('status')).toHaveAttribute('aria-label', 'Athena failed: Needs attention')
    view.rerender(<TaskHolograms {...props} task={{ ...task, mode: 'idle' }} />)
    expect(view.container).toBeEmptyDOMElement()
  })
})
