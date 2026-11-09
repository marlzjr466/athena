/** Stable IDs are independent of the original (including Unicode) filenames. */
export const VROID_ACTIONS = [
  { id: 'angry', label: 'Angry', file: 'angry.vrma' },
  { id: 'blush', label: 'Blush', file: 'blush.vrma' },
  { id: 'bow', label: 'Bow', file: 'bow.vrma' },
  { id: 'clapping', label: 'Clapping', file: 'clapping.vrma' },
  { id: 'goodbye', label: 'Goodbye', file: 'goodbye.vrma' },
  { id: 'idle', label: 'Idle', file: 'idle.vrma' },
  { id: 'jump', label: 'Jump', file: 'jump.vrma' },
  { id: 'look-around', label: 'Look Around', file: 'look-around.vrma' },
  { id: 'relax', label: 'Relax', file: 'relax.vrma' },
  { id: 'sad', label: 'Sad', file: 'sad.vrma' },
  { id: 'sleepy', label: 'Sleepy', file: 'sleepy.vrma' },
  { id: 'surprised', label: 'Surprised', file: 'surprised.vrma' },
  { id: 'thinking', label: 'Thinking', file: 'thinking.vrma' },
  { id: 'show-full-body', label: 'Show Full Body', file: 'VRMA_01(全身を見せる).vrma' },
  { id: 'greeting', label: 'Greeting', file: 'VRMA_02(挨拶).vrma' },
  { id: 'peace-sign', label: 'Peace Sign', file: 'VRMA_03(Vサイン).vrma' },
  { id: 'shooting-gesture', label: 'Shooting Gesture', file: 'VRMA_04(撃つ).vrma' },
  { id: 'spinning', label: 'Spinning', file: 'VRMA_05(回る).vrma' },
  { id: 'model-pose', label: 'Model Pose', file: 'VRMA_06(モデルポーズ).vrma' },
  { id: 'squat-exercise', label: 'Squat Exercise', file: 'VRMA_07(屈伸運動).vrma' },
] as const
export type VroidActionId = typeof VROID_ACTIONS[number]['id']
export const VROID_ACTION_IDS = VROID_ACTIONS.map(action => action.id) as [VroidActionId, ...VroidActionId[]]
export const VROID_RANDOM_IDS = VROID_ACTION_IDS.filter(id => id !== 'idle')
export const VROID_IDLE_MS = 3000
export const VROID_FADE_MS = 220
export interface VroidPlayback {
  action: VroidActionId
  startedAt: number
  duration: number
  loop: boolean
  speed: number
}
export interface VroidActionSession extends VroidPlayback {
  sequence: number
  source: 'idle' | 'random' | 'manual' | 'task'
  fadeMs: number
  previous?: VroidPlayback
  previousVoice?: VroidVoicePlayback
}
export type VroidVoicePhase = 'listening' | 'thinking' | 'talking'
export interface VroidVoicePlayback { phase: VroidVoicePhase; startedAt: number }
export interface VroidVoiceSession extends VroidVoicePlayback {
  source: 'floating-voice'
  sequence: number
  fadeMs: number
  previous?: VroidVoicePlayback
  previousAction?: VroidPlayback
}
export interface VroidVoiceClips {
  /** Humanoid-only gesture layer; never contains face/expression tracks. */
  gestures?: import('three').AnimationClip
  /** Expression-only layer with mouth visemes removed so live lip sync wins. */
  expressions?: import('three').AnimationClip
  expressionNames: string[]
}
export interface VroidClipReport { id: VroidActionId; duration?: number; error?: string }
export interface VroidActionSnapshot {
  session: VroidActionSession | null
  voiceSession: VroidVoiceSession | null
  clips: VroidClipReport[]
  blocked: boolean
}
export function vroidPlaybackTime(playback: VroidPlayback, now: number): number {
  const time = Math.max(0, (now - playback.startedAt) / 1000 * playback.speed)
  return playback.loop ? time % playback.duration : Math.min(playback.duration, time)
}
