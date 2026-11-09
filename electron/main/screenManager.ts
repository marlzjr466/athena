import { screen, type BrowserWindow } from 'electron'
import type { DisplayArea } from '../../shared/geometry'
import type { Settings } from '../../shared/settings'

export function getDisplays(): DisplayArea[] {
  const primary = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((display, i) => ({ ...display.workArea, id: display.id, label: display.label || `Display ${i + 1}`, primary: display.id === primary }))
}
export function currentArea(window: BrowserWindow): DisplayArea {
  const display = screen.getDisplayMatching(window.getBounds())
  return getDisplays().find((area) => area.id === display.id)!
}
export function movementArea(window: BrowserWindow, settings: Settings): DisplayArea {
  const displays = getDisplays()
  if (settings.monitorMode === 'primary') return displays.find((display) => display.primary)!
  if (settings.monitorMode === 'selected') return displays.find((display) => display.id === settings.selectedDisplay) ?? currentArea(window)
  if (settings.monitorMode === 'any' && settings.crossMonitor) return displays[Math.floor(Math.random() * displays.length)]
  return currentArea(window)
}
