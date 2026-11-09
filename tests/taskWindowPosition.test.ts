// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { WindowManager } from '../electron/main/windowManager'
import { defaultSettings } from '../shared/settings'

vi.mock('electron', () => ({ BrowserWindow: class {}, app: {}, screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) } }))

it.each([{ x: 0, y: 0 }, { x: 820, y: 620 }, { x: 400, y: 300 }])('retains the desktop center without native sliding at $x,$y', ({ x, y }) => {
  const manager = new WindowManager(() => ({ ...defaultSettings, size: 180 }))
  const original = { x, y, width: 180, height: 180 }
  let bounds = { ...original }
  const setBounds = vi.fn((next: typeof bounds) => { bounds = { ...next } })
  manager.floating = { isDestroyed: () => false, getBounds: () => ({ ...bounds }), setBounds } as unknown as typeof manager.floating
  const anchor = manager.setTaskVisualMode(true, true)!
  expect(bounds.x + anchor.x).toBe(x + 90)
  expect(bounds.y + anchor.y).toBe(y + 90)
  expect(setBounds).toHaveBeenLastCalledWith(bounds, false)
  manager.setTaskVisualMode(true, true)
  expect(setBounds).toHaveBeenCalledTimes(1)
  manager.setTaskVisualMode(false, true)
  expect(bounds).toEqual(original)
  expect(setBounds).toHaveBeenLastCalledWith(original, false)
})
