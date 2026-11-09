import { memo, type CSSProperties } from 'react'
import type { TaskVisualSnapshot } from '../../../shared/contracts'
import { taskScreenTitle } from '../../../shared/taskActivity'
import { useVisibility } from '../../hooks/useVisibility'
import '../../styles/taskHolograms.css'

/** Accessible task status and a brief finish pulse; the sole screen lives in Athena's 3D scene. */
export const TaskHolograms = memo(function TaskHolograms({ task, enabled, completionEnabled, reduced, characterSize, active }: { task?: TaskVisualSnapshot; enabled: boolean; completionEnabled: boolean; reduced: boolean; characterSize: number; active: boolean }) {
  const documentVisible = useVisibility()
  const mode = task?.mode ?? 'idle'
  const outcome = ['completed', 'failed', 'cancelled'].includes(mode)
  const title = taskScreenTitle(mode, task?.activityType)
  const screenType = title.toLowerCase().replaceAll(' ', '-')
  if (!enabled || mode === 'idle' || (outcome && !completionEnabled)) return null
  return <div className={`task-holograms ${outcome ? `task-holograms-${mode}` : ''} ${reduced ? 'task-holograms-reduced' : ''} ${!active || !documentVisible ? 'is-hidden' : ''}`} data-screen={screenType} role="status" aria-label={`Athena ${outcome ? mode : 'working'}: ${title}`}>
    <div className="task-holo-orbit" style={{ left: task!.anchor.x, top: task!.anchor.y + characterSize * .36 } as CSSProperties} aria-hidden="true" />
  </div>
})
