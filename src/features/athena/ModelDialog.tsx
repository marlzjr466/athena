import { useEffect, useRef, useState } from 'react'
import { MODEL_NAME_LIMIT, validateModelName, type ImportedAvatar, type ModelPick } from '../../../shared/avatarModels'
import { forgetModelPortrait, integrateImportedAvatar, modelCommand } from '../../three/importAvatar'

export function ModelDialog({ models, rename, remove, onClose }: { models: ImportedAvatar[]; rename?: ImportedAvatar; remove?: ImportedAvatar; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [pick, setPick] = useState<ModelPick>()
  const [name, setName] = useState(rename?.name ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  async function choose() {
    setBusy(true); setError('')
    try { const result = await modelCommand({ action: 'pick' }); if (result.pick) { setPick(result.pick); setName(result.pick.suggestedName) } }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  async function confirm() {
    setError('')
    try {
      if (remove) {
        setBusy(true)
        await modelCommand({ action: 'delete', id: remove.id })
        forgetModelPortrait(remove.id)
        onClose()
        return
      }
      const valid = validateModelName(name, models, rename?.id)
      if (!rename && !pick) throw new Error('Select a .vrm file first.')
      setBusy(true)
      const result = await modelCommand(rename ? { action: 'rename', id: rename.id, name: valid } : { action: 'import', token: pick!.token, name: valid })
      if (!rename && result.model?.importStatus === 'processing') {
        // Keep integration alive across navigation; it owns its own resources.
        void integrateImportedAvatar(result.model).catch(console.error)
      }
      onClose()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false) }
  }
  return <dialog className="model-dialog" ref={dialog} aria-labelledby="model-dialog-title" onCancel={event => { if (busy) event.preventDefault(); else onClose() }}>
    <form onSubmit={event => { event.preventDefault(); void confirm() }}>
      <h2 id="model-dialog-title">{remove ? `Delete ${remove.name}?` : rename ? 'Rename Model' : 'Add Model'}</h2>
      {remove ? <p>This permanently removes {remove.name} and its imported model, thumbnail, and avatar settings from Athena. Your original VRM file is kept. If active, Athena will switch to the default avatar.</p> : <>
        {!rename && <><p>Import a self-contained VRM 0.x or 1.0 avatar (up to 150 MB). Files stay on this Mac. Existing compatible animations will be prepared automatically.</p><button type="button" className="button secondary" disabled={busy} onClick={() => void choose()}>Choose .vrm file</button><p>{pick?.fileName ?? 'No file selected'}</p></>}
        <label htmlFor="avatar-model-name">Model Name</label>
        <input id="avatar-model-name" autoFocus={Boolean(rename)} required maxLength={MODEL_NAME_LIMIT} value={name} disabled={busy} onChange={event => setName(event.target.value)} />
      </>}
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" className="button secondary" autoFocus={Boolean(remove)} disabled={busy} onClick={onClose}>Cancel</button><button className={`button ${remove ? 'model-delete-confirm' : 'primary'}`} disabled={busy || (!remove && !rename && !pick)}>{busy ? remove ? 'Deleting…' : 'Saving…' : remove ? 'Delete Model' : rename ? 'Save Name' : 'Import Model'}</button></footer>
    </form>
  </dialog>
}
