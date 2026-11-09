/** All timings are milliseconds. The final second is reserved for the handoff. */
export const SPLASH_TRANSITION_MS = 1000
export const STARTUP_IPC = { ready: 'athena:startup-ready', state: 'athena:startup-state', stage: 'athena:startup-stage' } as const
export type StartupStage = 'intro' | 'waiting' | 'exiting'
export interface StartupPresentation { stage: StartupStage; durationMs: number; startedAt: number }

export function splashDurationMs(value?: string | number): number {
  const seconds = value === undefined || value === '' ? 6 : Number(value)
  return Math.round(Math.min(8, Math.max(5, Number.isFinite(seconds) ? seconds : 6)) * 1000)
}

declare global {
  interface Window {
    athenaStartup?: { ready(): void }
    athenaSplash?: {
      getState(): Promise<StartupPresentation>
      onStage(callback: (state: StartupPresentation) => void): () => void
    }
  }
}
