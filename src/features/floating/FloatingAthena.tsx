import { useRef } from 'react'
import { AthenaScene } from '../../three/AthenaScene'
import { desktop } from '../../services/desktop'
import { useAthena } from '../../store/athenaStore'
import { HandsFreeAssistant } from '../voice/HandsFreeAssistant'
import { TaskHolograms } from './TaskHolograms'
import { avatarName } from '../../../shared/avatarModels'

export function FloatingAthena() {
  const pressed = useRef(false)
  const command = useAthena((state) => state.command)
  const snapshot = useAthena((state) => state.snapshot)
  const name = avatarName(snapshot?.settings.avatarVariant ?? 'vroid-athena', snapshot?.importedAvatars)
  return <div className="floating-surface">
    <div className="floating-render"><AthenaScene /></div>
    <TaskHolograms task={snapshot?.floatingVoiceActive ? undefined : snapshot?.taskVisual} enabled={Boolean(snapshot?.settings.taskHologramsEnabled && snapshot?.settings.taskActivityEnabled)} completionEnabled={snapshot?.settings.taskCompletionNotification ?? true} reduced={Boolean(snapshot?.settings.reducedMotion || snapshot?.reducedMotion || snapshot?.settings.doNotDisturb || (snapshot?.settings.reduceOnBattery && snapshot?.onBattery))} characterSize={snapshot?.settings.size ?? 120} active={Boolean(snapshot?.visible)} />
    <HandsFreeAssistant />
    <button className="character-hit-area" style={snapshot?.taskVisual && snapshot.taskVisual.mode !== 'idle' ? { left: snapshot.taskVisual.anchor.x - snapshot.settings.size * .32, top: snapshot.taskVisual.anchor.y - snapshot.settings.size * .44, width: snapshot.settings.size * .64, height: snapshot.settings.size * .86 } : undefined} aria-label={`${name}. Drag to move, or right-click for controls.`} onPointerDown={(event) => {
      if (event.button !== 0) return
      pressed.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
      void desktop.beginDrag().catch(() => { pressed.current = false })
    }} onPointerUp={async (event) => {
      if (event.button !== 0 || !pressed.current) return
      pressed.current = false
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      try { await desktop.endDrag() } catch { /* Drag errors do not activate voice input. */ }
    }} onPointerCancel={() => { if (pressed.current) void desktop.endDrag(); pressed.current = false }} onContextMenu={(event) => { event.preventDefault(); void command('open-menu') }} onKeyDown={(event) => {
      if (event.key === 'Escape') void command('close-panel')
    }} />
  </div>
}
