let currentLevel = 0

export function setVoiceAmplitude(level: number): void {
  currentLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0
}

export function voiceAmplitude(): number { return currentLevel }

export function mouthOpenForAmplitude(level: number, speaking: boolean): number {
  return speaking ? Math.min(1, Math.max(0, level)) : 0
}
