'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Box, Check, RotateCcw, Upload } from 'lucide-react';
import { useAvatarModels } from './AvatarModelProvider';
import { MODEL_NAME_LIMIT, VROID_DOWNLOAD_URL, validateModelFile, validateModelName } from './importValidation';

export function ModelImport() {
  const { preview, setPreview, importState, setImportState, importModel, restore, modelReady } = useAvatarModels();
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const busy = importState.phase === 'loading';
  useEffect(() => {
    if (importState.phase === 'ready') { setFile(null); if (input.current) input.current.value = ''; }
  }, [importState.phase]);
  function reset() {
    restore(); setFile(null); setName(''); setError('');
    if (input.current) input.current.value = '';
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    try {
      const validName = validateModelName(name);
      if (file) { validateModelFile(file); importModel(file, validName); }
      else if (preview.custom) { setPreview({ name: validName, custom: true }); setImportState({ phase: 'ready', message: `Your companion is now named ${validName}.` }); }
      else throw new Error('Choose a .vrm file to preview.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check your model and name.'); }
  }
  const message = error || importState.message;
  const hasError = !!error || importState.phase === 'error';
  return <div className="glass model-import" data-reveal>
    <div className="panel-heading"><span><Box size={15} /> A CHARACTER OF YOUR OWN</span><span className="live-badge">VRM IMPORT</span></div>
    <h3 id="model-import-title">Your model. Your name.</h3>
    <p className="model-description">Create a character in VRoid Studio, export a VRM, and give your companion a name in Athena. Your own look, with Athena’s intelligence alongside you.</p>
    <ol className="model-steps"><li><span>01</span>Create in VRoid</li><li><span>02</span>Export .vrm</li><li><span>03</span>Name in Athena</li></ol>
    <a className="button-secondary vroid-download" href={VROID_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">Download VRoid Studio <ArrowUpRight size={15} /><span className="sr-only"> (opens in a new tab)</span></a>
    <form onSubmit={submit} aria-labelledby="model-import-title" aria-busy={busy}>
      <div className="model-preview-heading"><span>TRY YOUR MODEL HERE</span><span>LOCAL 3D PREVIEW</span></div>
      <label className="demo-input-label" htmlFor="model-name">Companion name</label>
      <input id="model-name" type="text" value={name} maxLength={MODEL_NAME_LIMIT} placeholder="e.g. Nova" autoComplete="off" disabled={busy} aria-describedby="model-import-help" aria-invalid={!!error} onChange={event => { setName(event.target.value); setError(''); }} />
      <div className={`model-file-picker ${busy || !modelReady ? 'is-disabled' : ''}`}>
        <Upload size={18} /><div><label htmlFor="model-file">Choose VRM file</label><span>{file ? file.name : 'Exported .vrm · up to 50 MB'}</span></div>
        <input ref={input} id="model-file" type="file" accept=".vrm" disabled={busy || !modelReady} aria-describedby="model-import-help" onChange={event => {
          const selected = event.target.files?.[0];
          if (!selected) return;
          setError('');
          try {
            validateModelFile(selected); setFile(selected);
            if (!name.trim()) setName(selected.name.replace(/\.vrm$/i, '').slice(0, MODEL_NAME_LIMIT));
          } catch (failure) { setFile(null); event.target.value = ''; setError((failure as Error).message); }
        }} />
      </div>
      <p className="tiny" id="model-import-help">Use an exported .vrm, not the .vroid project file. This preview stays in your browser until you leave or reload. Import it separately in the Athena desktop app to keep it there.</p>
      <div className="model-import-actions"><button className="button-primary" type="submit" disabled={busy || !modelReady || (!file && !preview.custom)}>{busy ? 'Preparing model…' : file ? 'Preview my model' : preview.custom ? 'Save name' : 'Preview my model'}{!busy && (preview.custom && !file ? <Check size={14} /> : <Upload size={14} />)}</button>
        {(preview.custom || busy) && <button className="text-button muted" type="button" onClick={reset}><RotateCcw size={13} />{busy ? 'Cancel preview' : 'Restore Athena'}</button>}
      </div>
      <p className={`model-import-message ${hasError ? 'is-error' : ''}`} role={hasError ? 'alert' : 'status'}>{message}</p>
      {!modelReady && <p className="tiny">A working 3D scene is needed for the local preview. You can still create your character and import it in the desktop app.</p>}
    </form>
  </div>;
}
