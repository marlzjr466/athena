import { useEffect, useState } from 'react'
import type { MeetingAPI, MeetingScreenAccess as Access } from '../../../shared/meetings'

export function MeetingScreenAccess({ api, consent, busy }: { api?: MeetingAPI; consent: boolean; busy: boolean }) {
  const [access, setAccess] = useState<Access>(), [pending, setPending] = useState(false), [error, setError] = useState('')
  const run = async (operation: 'check' | 'request' | 'settings' | 'reveal' | 'restart') => {
    if (!api) return
    setPending(true)
    try {
      const result = await api.command({ action: 'screen-access', operation })
      if (result.screenAccess) setAccess(result.screenAccess)
      setError(result.ok ? '' : result.message || 'Could not check screen access.')
    } catch { setError('Could not check screen access. Reopen Athena if it is restarting.') }
    finally { setPending(false) }
  }
  useEffect(() => {
    const refresh = () => { void run('check') }
    refresh(); window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [api])
  const allowed = access?.status === 'granted' || access?.status === 'not-required'
  return <details className="meeting-screen-access">
    <summary>Screen access · {access ? allowed ? 'Allowed' : access.status === 'restricted' ? 'Restricted' : 'Not granted to this app' : 'Checking…'}</summary>
    <p>If Athena is already enabled in macOS but access is still denied, its saved grant may belong to an older build. Remove the stale Athena entry from Screen &amp; System Audio Recording, add this exact app again, then restart Athena.</p>
    {access && <code>{access.appPath}</code>}
    <div className="meeting-row">
      <button disabled={pending || !consent || allowed || access?.status === 'restricted'} onClick={() => void run('request')}>Request screen access</button>
      <button disabled={pending} onClick={() => void run('settings')}>Open System Settings</button>
      <button disabled={pending} onClick={() => void run('reveal')}>Show this Athena app</button>
      <button disabled={pending || busy} title={busy ? 'Stop recording and wait for analysis before restarting.' : 'Save the meeting and restart this app to reload macOS permission.'} onClick={() => void run('restart')}>Restart Athena</button>
      <button disabled={pending} onClick={() => void run('check')}>Refresh access</button>
    </div>
    <small>Checking or requesting access does not take a screenshot or record audio.</small>
    {error && <p role="alert">{error}</p>}
  </details>
}
