import { MeetingView } from '../features/meetings/MeetingView'
import { useEffect } from 'react'
import { ControlCenter } from './ControlCenter'
import { FloatingAthena } from '../features/floating/FloatingAthena'
import { MiniPanel } from '../features/floating/MiniPanel'
import { connectDesktop, useAthena } from '../store/athenaStore'

export function App() {
  const surface = new URLSearchParams(window.location.search).get('surface') ?? 'control'
  const snapshot = useAthena((state) => state.snapshot)
  const error = useAthena((state) => state.error)
  useEffect(connectDesktop, [])
  useEffect(() => { document.documentElement.dataset.surface = surface }, [surface])
  useEffect(() => {
    if (surface !== 'control' || !snapshot) return
    // A connected snapshot and two paint opportunities, not just a loaded HTML shell.
    let second = 0
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => window.athenaStartup?.ready()) })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [surface, Boolean(snapshot)])
  if (surface === 'meeting') return <MeetingView floating />
  if (!snapshot) return surface === 'floating' ? null : <div className="loading-screen"><span>ATHENA</span><p>{error ?? 'A little presence is on its way…'}</p></div>
  if (surface === 'floating') return <FloatingAthena />
  if (surface === 'panel') return <MiniPanel />
  return <ControlCenter />
}
