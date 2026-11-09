import type { AthenaState } from './contracts'

export type BehaviorEvent = 'MOVE' | 'DRAG' | 'REST' | 'ACKNOWLEDGE' | 'SLEEP' | 'FAIL'
export function transition(state: AthenaState, event: BehaviorEvent): AthenaState {
  if (event === 'FAIL') return 'error'
  if (event === 'DRAG') return 'moving'
  if (event === 'ACKNOWLEDGE') return 'happy'
  if (event === 'REST') return 'idle'
  if (event === 'SLEEP') return state === 'idle' ? 'sleeping' : state
  if (event === 'MOVE') return ['idle', 'floating', 'sleeping', 'happy'].includes(state) ? 'moving' : state
  return state
}

export type LocalIntent = 'pin' | 'unpin' | 'hide' | 'show' | 'open-settings' | 'smaller' | 'bigger' | 'help' | 'unknown'
export function parseLocalIntent(text: string): LocalIntent {
  const value = text.toLowerCase().replace(/[.!?]/g, '').trim().replace(/^(hey )?athena[, ]+/, '')
  if (/^(stay here|pin( yourself)?|stop floating)$/.test(value)) return 'pin'
  if (/^(unpin( yourself)?|resume floating|start floating)$/.test(value)) return 'unpin'
  if (/^(hide( yourself)?|hide athena)$/.test(value)) return 'hide'
  if (/^(show( yourself)?|show athena)$/.test(value)) return 'show'
  if (/^(open( your)? settings|settings)$/.test(value)) return 'open-settings'
  if (/^(make yourself |get )?smaller$/.test(value)) return 'smaller'
  if (/^(make yourself |get )?(bigger|larger)$/.test(value)) return 'bigger'
  if (/^(help|what can you do)$/.test(value)) return 'help'
  return 'unknown'
}
