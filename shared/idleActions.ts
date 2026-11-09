export const IDLE_ACTIONS = ['sitting', 'slight-jump', 'wave', 'turn-around', 'front-flip', 'back-flip', 'small-spin', 'look-around', 'stretch', 'hover-bounce', 'bow', 'happy-pose'] as const
export type IdleActionId = typeof IDLE_ACTIONS[number]
export const ACTION_DEFINITIONS: Record<IdleActionId, { label: string; durationMs: number }> = {
  sitting: { label: 'Sitting', durationMs: 3200 },
  'slight-jump': { label: 'Slight Jump', durationMs: 1100 },
  wave: { label: 'Wave / Hello', durationMs: 2200 },
  'turn-around': { label: 'Turn Around', durationMs: 2200 },
  'front-flip': { label: 'Front Flip', durationMs: 1800 },
  'back-flip': { label: 'Back Flip', durationMs: 1800 },
  'small-spin': { label: 'Small Spin', durationMs: 1500 },
  'look-around': { label: 'Look Around', durationMs: 2700 },
  stretch: { label: 'Stretch', durationMs: 2600 },
  'hover-bounce': { label: 'Hover Bounce', durationMs: 1600 },
  bow: { label: 'Bow', durationMs: 2000 },
  'happy-pose': { label: 'Happy Pose', durationMs: 2200 },
}
export interface IdleActionSession { id: IdleActionId; startedAt: number; durationMs: number }
export function chooseIdleAction(enabled: readonly IdleActionId[], previous: IdleActionId | null, random = Math.random): IdleActionId | null {
  const candidates = enabled.length > 1 ? enabled.filter((id) => id !== previous) : enabled
  return candidates.length ? candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))] : null
}
