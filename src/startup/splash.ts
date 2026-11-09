import { type StartupPresentation } from '../../shared/startup'

const root = document.querySelector<HTMLElement>('.splash')!
const host = document.querySelector<HTMLElement>('.splash-character')!
const particles = document.querySelector<HTMLElement>('.splash-particles')!
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
let stopped = false
let cleanupScene: (() => void) | undefined
let state: StartupPresentation = { stage: 'intro', durationMs: 6000, startedAt: 0 }
const abort = new AbortController()

document.querySelectorAll<HTMLElement>('h1 span').forEach((letter, i) => letter.style.setProperty('--letter', String(i)))
// Deterministic, sparse dust. CSS compositing keeps it alive even without WebGL.
for (let i = 0; i < (reduced ? 12 : 42); i++) {
  const dot = document.createElement('i')
  dot.className = 'splash-particle'
  dot.style.cssText = `--x:${(i * 61.803) % 100}%;--y:${(i * 37.137) % 100}%;--size:${i % 5 === 0 ? 2 : 1}px;--alpha:${.15 + i % 4 * .1};--drift:${5 + i % 6}s;--delay:${-i % 9}s`
  particles.append(dot)
}
const apply = (next: StartupPresentation) => {
  if (stopped) return
  state = next
  root.style.setProperty('--intro', `${next.durationMs - 1000}ms`)
  if (next.startedAt) root.classList.add('playing')
  root.classList.toggle('exiting', next.stage === 'exiting')
  root.dataset.stage = next.stage
  if (next.stage === 'waiting') document.querySelector('.splash-status')!.textContent = 'Your workspace is coming into focus…'
}
const off = window.athenaSplash?.onStage(apply)
void window.athenaSplash?.getState().then(apply).catch(() => {})
if (!window.athenaSplash) apply({ ...state, startedAt: Date.now() })

// Keep the first paint independent of Three.js and of all application modules.
void import('./splashScene').then(({ createSplashScene }) => {
  if (stopped) return
  cleanupScene = createSplashScene(host, { signal: abort.signal, reduced, presentation: () => state })
}).catch(() => { host.dataset.fallback = 'true' })

function stop() {
  if (stopped) return
  stopped = true
  abort.abort(); off?.(); cleanupScene?.()
  window.removeEventListener('pagehide', stop)
  window.removeEventListener('beforeunload', stop)
  particles.replaceChildren()
}
window.addEventListener('pagehide', stop)
window.addEventListener('beforeunload', stop)
