import { useEffect, useState } from 'react'
import type { ChatMessage } from '../../../shared/chat'
import { isVideoOperation, type MediaJob, type MediaOperation } from '../../../shared/mediaGeneration'
import { desktop } from '../../services/desktop'

export function MediaJobControls({
  sessionId,
  message,
  context = desktop.chatContext,
}: {
  sessionId: string
  message: ChatMessage
  context?: typeof desktop.chatContext
}) {
  const j = message.mediaJob!,
    active = ['routing', 'submitting', 'processing'].includes(j.status)
  const [now, setNow] = useState(Date.now),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    if (active) {
      const timer = setInterval(() => setNow(Date.now()), 1000)
      return () => clearInterval(timer)
    }
  }, [active])
  const [preview, setPreview] = useState('')
  useEffect(() => {
    let live = true
    setPreview('')
    if (message.mediaPreview)
      void context({
        action: 'artifact-url',
        sessionId,
        id: message.mediaPreview.id,
      })
        .then((r) => {
          if (live && r.assetUrl) setPreview(r.assetUrl)
        })
        .catch(() => {})
    return () => {
      live = false
    }
  }, [sessionId, message.mediaPreview?.id, context])
  async function act(action: 'approve' | 'stop' | 'track' | 'cancel-provider') {
    setBusy(true)
    setError('')
    try {
      const r = await desktop.mediaGeneration({
        action,
        sessionId,
        messageId: message.id,
        route: j.route,
      })
      if ('ok' in r && !r.ok) setError(r.message ?? 'Unable to update request.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update generation.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="media-job">
      {preview && <img className="media-partial" alt="Generation in progress" src={preview} />}
      <small>
        {j.status} · {Math.max(0, Math.floor(((active ? now : j.updated) - j.started) / 1000))}s
        {j.billing ? ' · ' + (j.billing === 'api' ? 'Paid API' : j.billing) : ''}
      </small>
      {j.status === 'approval' && (
        <button disabled={busy} className="chat-action" onClick={() => void act('approve')}>
          {j.billing === 'subscription' ? 'Use subscription tool' : 'Approve one paid request'}
        </button>
      )}
      {j.status === 'processing' && j.canCancel && (
        <button
          type="button"
          disabled={busy}
          className="chat-action"
          onClick={() => void act('cancel-provider')}
        >
          Cancel provider job
        </button>
      )}
      {(active || j.status === 'approval') && (
        <button disabled={busy} className="chat-action" onClick={() => void act('stop')}>
          {j.status === 'approval' ? 'Decline' : 'Stop monitoring'}
        </button>
      )}
      {j.remoteId && ['failed', 'stopped'].includes(j.status) && (
        <button disabled={busy} className="chat-action" onClick={() => void act('track')}>
          Check existing job
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}

export function MediaRevision({
  sessionId,
  parentId,
  video,
  job,
}: {
  sessionId: string
  parentId?: string
  video: boolean
  job?: MediaJob
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function compose(operation: MediaOperation) {
    setBusy(true)
    setError('')
    try {
      const result = await desktop.mediaGeneration({
        action: 'compose',
        sessionId,
        mode: isVideoOperation(operation) ? 'video' : 'image',
        parentId,
        operation,
      })
      if ('ok' in result && !result.ok) setError(result.message ?? 'Could not select this reference.')
      else document.querySelector<HTMLTextAreaElement>('[aria-label="Message Athena"]')?.focus()
    } catch {
      setError('Open the source conversation to edit this media.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="media-revision">
      <button
        type="button"
        className="chat-action"
        disabled={busy}
        onClick={() => void compose(video ? 'edit-video' : 'edit-image')}
      >
        Edit
      </button>
      <button
        type="button"
        className="chat-action"
        disabled={busy}
        onClick={() => void compose(video ? 'extend-video' : 'animate')}
      >
        {video ? 'Extend video' : 'Animate image'}
      </button>
      {!video && (
        <button type="button" className="chat-action" disabled={busy} onClick={() => void compose('gif')}>
          Create GIF
        </button>
      )}
      {job && (
        <button
          type="button"
          className="chat-action"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError('')
            try {
              const r = await desktop.mediaGeneration({
                action: 'generate',
                sessionId,
                requestId: crypto.randomUUID(),
                prompt: job.prompt,
                operation: job.operation,
                parentId: job.parentId,
                options: job.options,
              })
              if ('ok' in r && !r.ok) setError(r.message ?? 'Could not regenerate.')
            } catch {
              setError('Could not regenerate this media.')
            } finally {
              setBusy(false)
            }
          }}
        >
          Regenerate
        </button>
      )}
      {parentId && (
        <button
          type="button"
          className="chat-action"
          disabled={busy}
          onClick={async () => {
            try {
              const r = await desktop.mediaGeneration({
                action: 'remove-asset',
                sessionId,
                id: parentId,
              })
              if ('ok' in r && !r.ok) setError(r.message ?? 'Deletion cancelled.')
            } catch {
              setError('Could not delete this media.')
            }
          }}
        >
          Delete file
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
