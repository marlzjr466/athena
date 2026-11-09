import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, BookOpen, Download, FileText, Folder, Lightbulb, Network, Play, RotateCcw, Package } from 'lucide-react'
import { desktop } from '../../services/desktop'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { AcademyModelPanel, AcademyProgress, AcademyStatus, FineStep } from './AcademyDesign'
import { benchmarkFormat, ComparisonResults } from './AcademyTrainingPanel'
import { defaultTrainingSettings, mlxFamilyCandidate, suggestedCheckpoint, type TrainingCommand, type TrainingProgress, type TrainingSettings, type TrainingSnapshot, type DatasetSplit } from '../../../shared/academyTraining'
import type { LocalModel } from '../../../shared/localAI'

const steps = ['Select Model', 'Prepare Training Model', 'Prepare Dataset', 'Configure Training', 'Start Fine-Tuning', 'Evaluate Trained Model', 'Activate Trained Model']
const presets = [{ name: 'Quick Test', hint: '10 iterations', iterations: 10, checkpointEvery: 5 }, { name: 'Balanced', hint: 'Recommended', iterations: 100, checkpointEvery: 25 }, { name: 'Advanced', hint: '250 iterations', iterations: 250, checkpointEvery: 50 }]
const trainingFormat = JSON.stringify({ messages: [{ role: 'user', content: 'Your training question' }, { role: 'assistant', content: 'Your verified answer' }] })
const loss = (value?: number) => value === undefined ? 'Not measured' : value.toFixed(3)
function downloadSample() {
  const url = URL.createObjectURL(new Blob([trainingFormat + '\n'], { type: 'application/jsonl' }))
  const link = document.createElement('a'); link.href = url; link.download = 'training-format-example.jsonl'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function AcademyFineTuningView({ model, models = [model], onModelChange, onBack }: { model: LocalModel; models?: LocalModel[]; onModelChange?: (value: string) => void; onBack?: () => void }) {
  const [data, setData] = useState<TrainingSnapshot | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<TrainingProgress | null>(null)
  const [repository, setRepository] = useState(suggestedCheckpoint(model.name))
  const [settings, setSettings] = useState<TrainingSettings>(defaultTrainingSettings)
  const [preset, setPreset] = useState('Balanced')
  const [jobId, setJobId] = useState('')
  const [details, setDetails] = useState(false)
  const [format, setFormat] = useState(false)
  const [previousAdapter, setPreviousAdapter] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [step, setStep] = useState(1)
  const datasetInput = useRef<HTMLInputElement>(null)
  const evaluationInput = useRef<HTMLInputElement>(null)
  const validationInput = useRef<HTMLInputElement>(null)
  const testInput = useRef<HTMLInputElement>(null)
  const [datasetNotices, setDatasetNotices] = useState<Partial<Record<DatasetSplit | 'benchmark' | 'mode', { text: string; error: boolean }>>>({})
  const [datasetOperation, setDatasetOperation] = useState(false)
  const alive = useRef(true)
  const initialized = useRef('')
  const refresh = async () => { const result = await desktop.getAcademyTraining(); if (alive.current) setData(result) }
  useEffect(() => {
    alive.current = true
    void refresh().catch(() => { if (alive.current) { setNotice('The local training service could not be inspected.'); setError(true) } })
    const unsubscribe = desktop.onAcademyTrainingProgress?.(value => {
      if (!alive.current) return
      setProgress(value)
      if (['completed', 'cancelled', 'failed', 'interrupted', 'idle'].includes(value.stage)) void refresh().catch(() => {})
    })
    return () => { alive.current = false; unsubscribe?.() }
  }, [])
  const profile = data?.profiles.find(item => item.model === model.name && item.modelDigest === model.digest)
  useEffect(() => {
    if (!data || initialized.current === model.name + model.digest) return
    initialized.current = model.name + model.digest
    setDatasetNotices({})
    setSettings(profile?.settings ?? defaultTrainingSettings)
    if (profile?.settings) setPreset(presets.find(item => item.iterations === profile.settings?.iterations && item.checkpointEvery === profile.settings.checkpointEvery && profile.settings.learningRate === defaultTrainingSettings.learningRate && profile.settings.rank === 8 && profile.settings.batchSize === 1)?.name ?? 'Custom')
  }, [data, model.name, model.digest, profile])
  const active = progress && ['installing', 'downloading', 'training', 'evaluating'].includes(progress.stage) ? progress : data?.active
  useEffect(() => {
    if (!active) return
    const interval = setInterval(() => { setNow(Date.now()); void refresh().catch(() => {}) }, 2000)
    return () => clearInterval(interval)
  }, [Boolean(active)])
  const jobs = data?.jobs.filter(item => item.model === model.name && item.modelDigest === model.digest).slice().reverse() ?? []
  const job = jobs.find(item => item.id === jobId) ?? jobs[0]
  const comparisons = data?.comparisons?.filter(item => item.jobId === job?.id) ?? []
  const comparison = comparisons.at(-1)
  const candidate = mlxFamilyCandidate(model.family, data?.runtime.architectures)
  const manual = profile?.datasetMode === 'manual'
  const datasetSelection = profile?.datasetSelections?.[manual ? 'manual' : 'automatic']
  const datasetsReady = Boolean(profile?.datasetId && (!manual || (['train', 'valid', 'test'] as const).every(split => datasetSelection?.files[split]?.count)))
  const batchReady = !manual || Boolean(profile?.datasetCounts && profile.datasetCounts.train >= settings.batchSize && profile.datasetCounts.valid >= settings.batchSize)
  const ready = Boolean(batchReady && candidate && data?.runtime.ready && profile?.checkpointId && datasetsReady)
  const locked = busy || Boolean(active)
  const ownActive = active?.model === model.name ? active : undefined
  const iteration = ownActive?.stage === 'training' ? ownActive.iteration : job?.iteration ?? 0
  const iterations = ownActive?.stage === 'training' ? ownActive.iterations : job?.iterations ?? settings.iterations
  const elapsed = job ? Math.max(0, Math.floor(((job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.startedAt)) / 1000)) : undefined
  const bestLoss = comparison?.variants.reduce((best, row) => row.validationLoss < best.validationLoss ? row : best)
  const selectedAdapter = job?.selectedAdapter ?? job?.adapterFiles.at(-1)
  const canCompare = !locked && Boolean(candidate && data?.runtime.ready && profile?.checkpointId && job?.adapterFiles.length)
  const run = async (command: TrainingCommand) => {
    setBusy(true); setNotice(''); setError(false)
    const slot = command.action === 'dataset-split-import' ? command.split : command.action === 'dataset-import' ? 'train' : command.action === 'evaluation-import' ? 'benchmark' : command.action === 'dataset-mode' ? 'mode' : undefined
    setDatasetOperation(Boolean(slot))
    try { const result = await desktop.academyTrainingCommand(command); if (alive.current) { setData(result.snapshot); if (slot) setDatasetNotices(previous => ({ ...previous, [slot]: { text: result.message ?? (result.ok ? 'Import saved.' : 'Import failed.'), error: !result.ok } })); setNotice(result.message ?? (result.ok ? 'Saved locally.' : 'Operation did not complete.')); setError(!result.ok); if (command.action !== 'configure') setProgress(null) } return result.ok }
    catch (cause) { if (alive.current) { if (slot) setDatasetNotices(previous => ({ ...previous, [slot]: { text: cause instanceof Error ? cause.message : 'Import failed.', error: true } })); setNotice(cause instanceof Error ? cause.message : 'Training service could not complete this operation.'); setError(true) } return false }
    finally { if (alive.current) setBusy(false) }
  }
  const saveSettings = (value: TrainingSettings) => void run({ action: 'configure', model: model.name, settings: value })
  const changeSetting = (key: keyof TrainingSettings, value: number) => { setPreset('Custom'); setSettings(current => ({ ...current, [key]: value })) }
  const validSettings = settings.iterations >= 10 && settings.iterations <= 500 && settings.learningRate >= .000001 && settings.learningRate <= .001 && settings.batchSize >= 1 && settings.batchSize <= 2 && settings.rank >= 4 && settings.rank <= 32 && settings.checkpointEvery >= 5 && settings.checkpointEvery <= 100
  const start = async () => { if (await run({ action: 'configure', model: model.name, settings })) await run({ action: 'train', model: model.name, iterations: settings.iterations }) }
  const importFile = async (file: File | undefined, split: DatasetSplit | 'benchmark') => {
    if (!file) return
    setBusy(true)
    setDatasetNotices(previous => ({ ...previous, [split]: { text: `Reading ${file.name}…`, error: false } }))
    const input = split === 'benchmark' ? evaluationInput : split === 'train' ? datasetInput : split === 'valid' ? validationInput : testInput
    try {
      if (!file.name.toLowerCase().endsWith('.jsonl')) throw new Error('Select a file with the .jsonl extension.')
      if (file.size > (split === 'benchmark' ? 8 : 20) * 1024 * 1024) throw new Error('The JSONL file exceeds the import size limit.')
      const content = await file.text()
      await run(split === 'benchmark' ? { action: 'evaluation-import', model: model.name, fileName: file.name, content }
        : manual ? { action: 'dataset-split-import', model: model.name, split, fileName: file.name, content }
        : { action: 'dataset-import', model: model.name, fileName: file.name, content })
    } catch (cause) {
      setDatasetOperation(true)
      setDatasetNotices(previous => ({ ...previous, [split]: { text: `${file.name}: ${cause instanceof Error ? cause.message : 'Could not read file.'}`, error: true } }))
    } finally { if (input.current) input.current.value = ''; if (alive.current) setBusy(false) }
  }
  const importNotice = (slot: DatasetSplit | 'benchmark' | 'mode') => datasetNotices[slot] && <p role={datasetNotices[slot]!.error ? 'alert' : 'status'} className={datasetNotices[slot]!.error ? 'ac-import-error' : 'ac-import-success'}>{datasetNotices[slot]!.text}</p>
  const jump = (number: number) => { setStep(number); document.getElementById(`fine-step-${number}`)?.scrollIntoView({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }) }
  return <>
    {onBack && <button className="ac-back" onClick={onBack}><ArrowLeft size={14} />Back to Athena Academy</button>}
    <div className="ac-fine-layout"><main className="ac-fine-main">
      <AcademyModelPanel fine model={model} models={models} onChange={onModelChange ?? (() => {})} disabled={!onModelChange || locked} />
      <nav className="ac-step-nav" aria-label="Fine-tuning stages">{steps.map((title, i) => <button key={title} className={step === i + 1 ? 'active' : ''} onClick={() => jump(i + 1)} aria-current={step === i + 1 ? 'step' : undefined}><span>{i + 1}</span>{title}</button>)}</nav>
      <FineStep number={1} title={steps[0]} description="Choose the base model you want to fine-tune."><div className="ac-actions"><CustomSelect ariaLabel="Fine-tuning local model" value={model.name} options={models.map(item => ({ value: item.name, label: item.name }))} onChange={onModelChange ?? (() => {})} disabled={!onModelChange || locked} /><AcademyStatus tone={profile?.checkpointId && candidate ? 'success' : candidate ? 'blue' : 'warning'}>{profile?.checkpointId && candidate ? 'Validated training checkpoint' : candidate ? 'Checkpoint verification required' : 'Unsupported architecture'}</AcademyStatus></div>{!candidate && <p>Fine-tuning is not verified for {model.family ?? 'this architecture'}. Knowledge and skills training remain available.</p>}</FineStep>
      <FineStep number={2} title={steps[1]} description="Download the base model checkpoint from Hugging Face or use a local checkpoint folder. Ollama model blobs cannot be trained directly."><div className="ac-checkpoint-grid"><div><label className="ac-field">Source checkpoint repository<input value={repository} onChange={event => setRepository(event.target.value)} maxLength={160} placeholder="Organization/model-name" disabled={locked || !candidate} /></label><div className="ac-actions"><button className="button primary" disabled={locked || !candidate || !data?.runtime.ready || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository.trim())} onClick={() => void run({ action: 'checkpoint-download', model: model.name, repository: repository.trim() })}><Download size={15} />Download source checkpoint</button><button className="button secondary" disabled={locked || !candidate} onClick={() => void run({ action: 'checkpoint-local', model: model.name })}><Folder size={15} />Use local checkpoint folder</button></div></div><div className="ac-inset"><AcademyStatus tone={profile?.checkpointId ? 'success' : 'neutral'}>{profile?.checkpointId ? 'Checkpoint ready' : 'No checkpoint selected'}</AcademyStatus><p>{profile?.checkpointLabel ?? 'Suggested repositories are not proof of the installed model’s provenance. Review the source and license.'}</p>{profile?.checkpointId && <small>{profile.checkpointQuantized ? 'Quantized source · QLoRA' : 'Full-precision source · LoRA'}</small>}</div></div><details className="ac-runtime"><summary>{data?.runtime.message ?? 'Inspecting local MLX runtime…'}</summary><p>{data?.runtime.ready ? `Python ${data.runtime.pythonVersion ?? 'available'} · MLX ${data.runtime.mlxVersion ?? 'available'} · mlx-lm ${data.runtime.mlxLmVersion ?? 'available'}` : 'A dedicated MLX environment is required. Setup asks permission before downloading dependencies.'}</p>{data && !data.runtime.ready && <button className="button secondary" disabled={locked} onClick={() => void run({ action: 'install-runtime' })}>Set up local training runtime</button>}</details></FineStep>
      <FineStep number={3} title={steps[2]} description="Import validated JSONL conversations and choose how training, validation, and test data are prepared.">
        <label className="ac-field">Dataset mode<CustomSelect ariaLabel="Dataset mode" value={manual ? 'manual' : 'automatic'} disabled={locked} options={[{ value: 'automatic', label: 'Automatic Split' }, { value: 'manual', label: 'Manual Split' }]} onChange={mode => void run({ action: 'dataset-mode', model: model.name, mode: mode as 'manual' | 'automatic' })} /></label>
        {importNotice('mode')}
        <p>{manual ? 'Import all three files. Training examples update weights. Validation examples measure loss and select checkpoints. Test examples are reserved for final evaluation.' : 'Import one training file to create automatic train, validation, and test splits. Choose Manual Split to import separate files.'}</p>
        <div className="ac-dataset-grid">{(['train', 'valid', 'test'] as const).map(split => {
          const file = datasetSelection?.files[split]
          const count = profile?.datasetCounts?.[split] ?? 0
          const title = split === 'train' ? 'Training Dataset' : split === 'valid' ? 'Validation Dataset' : 'Independent Test Dataset'
          const input = split === 'train' ? datasetInput : split === 'valid' ? validationInput : testInput
          const imported = manual ? Boolean(file) : Boolean(profile?.datasetId)
          return <section className="ac-inset" key={split} aria-label={title}>
            <div className="ac-actions"><h4>{title} ({split}.jsonl)</h4><AcademyStatus tone={imported ? 'success' : 'neutral'}>{imported ? 'Validated' : 'Required'}</AcademyStatus></div>
            <div className="ac-file-row"><FileText size={24} /><div><strong>{file?.name ?? (!manual && profile?.datasetId ? profile.datasetName : undefined) ?? 'No dataset imported'}</strong><small>{count} {split === 'valid' ? 'validation' : split === 'train' ? 'training' : 'test'} examples{!manual && imported ? ' · automatic split' : ''}</small></div></div>
            <button className="button secondary" disabled={locked || (!manual && split !== 'train')} onClick={() => input.current?.click()}>{imported ? 'Replace file' : 'Import JSONL'}</button>
            {!manual && split !== 'train' && <small>Generated from the training import. Switch to Manual Split to replace independently.</small>}
            {importNotice(split)}
            <input className="ac-file-input" ref={input} type="file" accept=".jsonl,.JSONL,application/jsonl,application/x-ndjson" aria-label={split === 'train' ? 'Choose JSONL training dataset' : split === 'valid' ? 'Choose JSONL validation dataset' : 'Choose JSONL independent test dataset'} disabled={locked || (!manual && split !== 'train')} onChange={event => void importFile(event.currentTarget.files?.[0], split)} />
          </section>
        })}</div>
        {profile?.datasetCounts && <p aria-label="Dataset counts">{Object.values(profile.datasetCounts).reduce((a, b) => a + b, 0)} examples · {profile.datasetCounts.train} train · {profile.datasetCounts.valid} validation · {profile.datasetCounts.test} test</p>}
        {manual && !datasetsReady && <p>Import all three valid datasets before starting training.</p>}
        {manual && datasetsReady && !batchReady && <p>Training and validation each need at least one full batch. Reduce batch size or import more examples.</p>}
        {datasetSelection?.warnings.map(warning => <p key={warning} role="status">{warning}</p>)}
        {job?.datasetProvenance && job.datasetId !== profile?.datasetId && <p>Dataset selection differs from the selected past run. That run retains its original dataset files and hashes.</p>}
        {job?.datasetIntegrityError && <p role="alert">{job.datasetIntegrityError}</p>}
        {!manual && <details className="ac-runtime"><summary>Optional labeled task benchmarks</summary><p>This separate benchmark format uses track, prompt, and reference answers for task scoring.</p><button className="button secondary" disabled={locked} onClick={() => evaluationInput.current?.click()}>Import evaluation dataset</button><p>{profile?.evaluationDataset ? `${profile.evaluationDataset.name} · ${profile.evaluationDataset.count} validated tasks` : 'No labeled task benchmark imported.'}</p>{importNotice('benchmark')}<pre>{benchmarkFormat}</pre><input className="ac-file-input" ref={evaluationInput} type="file" accept=".jsonl,.JSONL" aria-label="Choose independent labeled evaluation JSONL" disabled={locked} onChange={event => void importFile(event.currentTarget.files?.[0], 'benchmark')} /></details>}
        <div className="ac-actions ac-format-actions"><button className="ac-link" onClick={downloadSample}>Download sample format</button><button className="ac-link" onClick={() => setFormat(!format)}>View JSONL format</button></div>
        {format && <div className="ac-inset"><h4>Conversation format for all three datasets</h4><pre>{trainingFormat}</pre><p>One JSON object per line. Use alternating user and assistant messages, optionally preceded by a system message. Assistant responses must be nonempty. Manual files retain their assigned split.</p></div>}
      </FineStep>
      <FineStep number={4} title={steps[3]} description="Choose training settings. Use a preset or customize advanced settings for your local model."><div className="ac-presets">{[...presets, { name: 'Custom', hint: 'Manual settings', iterations: settings.iterations, checkpointEvery: settings.checkpointEvery }].map(item => <button key={item.name} aria-pressed={preset === item.name} disabled={locked} onClick={() => { setPreset(item.name); if (item.name !== 'Custom') { const next = { ...defaultTrainingSettings, iterations: item.iterations, checkpointEvery: item.checkpointEvery }; setSettings(next); saveSettings(next) } }}><strong>{item.name}</strong><small>{item.hint}</small></button>)}</div><div className="ac-setting-grid"><label className="ac-inset ac-field">Training iterations<input type="number" min={10} max={500} value={settings.iterations} disabled={locked} onChange={event => changeSetting('iterations', Number(event.target.value))} /><small>Number of training iterations</small></label><div className="ac-inset"><label>Learning profile</label><strong>{preset}</strong><small>Batch {settings.batchSize} · rank {settings.rank}</small></div><div className="ac-inset"><label>Resource usage</label><strong>{job?.peakMemoryGB ? `${job.peakMemoryGB.toFixed(1)} GB peak` : 'Not estimated'}</strong><small>Duration depends on source model and data</small></div><label className="ac-inset ac-field">Checkpoint frequency<input type="number" min={5} max={100} value={settings.checkpointEvery} disabled={locked} onChange={event => changeSetting('checkpointEvery', Number(event.target.value))} /><small>Save every N iterations</small></label></div><details className="ac-advanced"><summary>Advanced settings (LoRA rank, learning rate, batch size)</summary><div className="ac-setting-grid">{([{ key: 'learningRate', label: 'Learning rate', min: .000001, max: .001, step: .000001 }, { key: 'batchSize', label: 'Training batch size', min: 1, max: 2, step: 1 }, { key: 'rank', label: 'LoRA rank', min: 4, max: 32, step: 1 }] as const).map(item => <label className="ac-field" key={item.key}>{item.label}<input type="number" min={item.min} max={item.max} step={item.step} value={settings[item.key]} disabled={locked} onChange={event => changeSetting(item.key, Number(event.target.value))} /></label>)}</div><p>Bounded to 1,024 tokens, eight trainable layers, gradient checkpointing, and batches of 1–2. These limits reduce memory pressure but cannot guarantee that every checkpoint fits 24 GB.</p></details>{JSON.stringify(profile?.settings ?? defaultTrainingSettings) !== JSON.stringify(settings) && <button className="button secondary" disabled={locked || !validSettings} onClick={() => saveSettings(settings)}>Save training settings</button>}</FineStep>
      <FineStep number={5} title={steps[4]} description="Start training with configured settings. Monitor real MLX progress, review metrics, and continue from a saved adapter checkpoint."><div className="ac-training-monitor"><div className="ac-module-actions"><button className="button primary" disabled={locked || !ready || !validSettings} onClick={() => void start()}><Play size={14} />Start Training</button><button className="button secondary" disabled={!canCompare || !ready || job?.datasetId !== profile?.datasetId || !validSettings} onClick={() => job && void run({ action: 'resume', model: model.name, jobId: job.id, iterations: settings.iterations })}>Continue from checkpoint</button><button className="button secondary" disabled={!active} onClick={() => void run({ action: 'cancel' })}>Cancel {active?.stage ?? 'training'}</button></div><div className="ac-inset"><div className="ac-actions"><AcademyStatus tone={ownActive ? 'blue' : job?.stage === 'completed' ? 'success' : job?.stage === 'failed' ? 'danger' : 'neutral'}>{ownActive ? ownActive.stage : job ? `Training ${job.stage}` : 'Ready when configured'}</AcademyStatus><small>{iteration}/{iterations} iterations</small></div><AcademyProgress value={iterations ? Math.round(iteration / iterations * 100) : 0} label="Training progress" /><div className="ac-metrics"><div><label>Training loss</label><strong>{loss(progress?.model === model.name ? progress.trainingLoss ?? job?.trainingLoss : job?.trainingLoss)}</strong></div><div><label>Validation loss</label><strong>{loss(job?.validationLoss)}</strong></div><div><label>Checkpoints saved</label><strong>{job?.adapterFiles.length ?? 0}</strong></div><div><label>Elapsed time</label><strong>{elapsed === undefined ? 'Not started' : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}</strong></div></div>{job?.error && <p role="alert">{job.error}</p>}</div></div>{!ready && <small>Select a validated source checkpoint, import a training dataset, and prepare the MLX runtime to start.</small>}{active && <p role="status">{active.message}{active.model !== model.name ? ` · ${active.model}` : ''}</p>}{jobs.length > 0 && <label className="ac-field">Training history<CustomSelect ariaLabel="Training history" value={job?.id ?? ''} onChange={value => { setJobId(value); setPreviousAdapter(null) }} disabled={locked} options={jobs.map(item => ({ value: item.id, label: `${new Date(item.startedAt).toLocaleString()} · ${item.stage} · ${item.iteration}/${item.iterations}` }))} /></label>}</FineStep>
      <FineStep number={6} title={steps[5]} description="Compare performance across checkpoints and evaluate on your specific, independently verified tasks."><div className="academy-comparison-scroll ac-compact-table"><table><thead><tr><th>Model / Checkpoint</th><th>Validation Loss ↓</th><th>Held-out Test Loss ↓</th><th>AI Coding</th><th>Git</th><th>Jira</th></tr></thead><tbody>{comparison ? comparison.variants.map(row => <tr key={row.id} className={comparison.recommendation === row.id ? 'recommended' : ''}><th>{row.label}{bestLoss?.id === row.id ? ' ★' : ''}</th><td>{loss(row.validationLoss)}</td><td>{loss(row.testLoss)}</td>{(['coding', 'git', 'jira'] as const).map(track => <td key={track}>{row.taskScores[track].total ? `${Math.round(row.taskScores[track].rate * 100)}% (${row.taskScores[track].correct}/${row.taskScores[track].total})` : 'Not measured'}</td>)}</tr>) : ['Original (base model)', ...(job?.adapterFiles ?? [])].map(label => <tr key={label}><th>{label}</th>{Array.from({ length: 5 }, (_, i) => <td key={i}>Not measured</td>)}</tr>)}</tbody></table></div><div className="ac-actions"><button className="button secondary" disabled={!canCompare} onClick={() => job && void run({ action: 'evaluate', model: model.name, jobId: job.id })}>Evaluate held-out test</button><button className="button primary" disabled={!canCompare} onClick={() => job && void run({ action: 'compare', model: model.name, jobId: job.id })}>Compare base + all checkpoints</button><button className="button secondary" disabled={!comparison} onClick={() => setDetails(!details)}>{details ? 'Hide' : 'View'} generated answers & details</button></div>{job?.testLoss !== undefined && <p>Selected adapter held-out loss: {loss(job.testLoss)}. Cross-checkpoint losses are measured separately in a comparison.</p>}{comparison ? <p>{bestLoss ? `★ Lowest validation loss: ${bestLoss.label}. ` : ''}{comparison.recommendation ? comparison.selectionBasis === 'validation' ? 'Checkpoint recommendation uses validation loss only. Select an adapter before final test evaluation.' : 'Recommended for manual review from measured evidence; never automatically activated.' : 'Insufficient evidence to recommend deployment. Review sample sizes, uncertainty, and task correctness.'}</p> : <p>No comparison measured for this run. Training-time validation loss is not proof of correctness.</p>}{details && <div className="ac-comparison-details">{comparisons.slice().reverse().map(result => <details key={result.id} open={result === comparison}><summary>Evaluation · {new Date(result.createdAt).toLocaleString()}</summary><ComparisonResults result={result} selectedAdapter={selectedAdapter} onReview={(exampleId, variantId, decision, note) => void run({ action: 'review-example', model: model.name, comparisonId: result.id, exampleId, variantId, decision, note })} /></details>)}</div>}</FineStep>
      <FineStep number={7} title={steps[6]} description="Activate the selected adapter with native MLX inference. Athena verifies the source checkpoint, tokenizer, adapter tensors, and actual generation before registering the model.">
        <div className="ac-actions"><button className="button primary" disabled={locked || !selectedAdapter || job?.stage !== 'completed'} onClick={() => job && selectedAdapter && void run({ action: 'activate-adapter', model: model.name, jobId: job.id, adapter: selectedAdapter })}><Play size={14} />Activate trained model</button><button className="button secondary" disabled={locked || !data?.mlxModels?.some(item => item.baseModel === model.name)} onClick={() => void run({ action: 'rollback-model', model: model.name })}><RotateCcw size={14} />Restore previous model</button><button className="button secondary" disabled={locked || !selectedAdapter} onClick={() => job && void run({ action: 'export-adapter', model: model.name, jobId: job.id })}><Package size={14} />Export adapter</button></div>
        <p>Registers Athena Coder v2 · MLX and selects it for new companion conversations. Existing Athena Chat conversations retain their selected model; use the chat model selector to switch. The original Ollama model remains available.</p>
        {job?.adapterFiles.length ? <label className="ac-field">Adapter checkpoint for activation / export / continuation<CustomSelect ariaLabel="Adapter checkpoint" value={selectedAdapter ?? ''} options={job.adapterFiles.map(value => ({ value, label: value }))} disabled={locked} onChange={async adapter => { const previous = selectedAdapter; if (await run({ action: 'select-adapter', model: model.name, jobId: job.id, adapter })) setPreviousAdapter(previous ?? null) }} /></label> : null}
        <button className="button secondary" disabled={locked || !previousAdapter} onClick={async () => { if (job && previousAdapter && await run({ action: 'select-adapter', model: model.name, jobId: job.id, adapter: previousAdapter })) setPreviousAdapter(null) }}>Rollback adapter selection</button>
        {data?.mlxDiagnostics?.map(item => <div className="ac-inset" key={item.id}><h4>{item.label} · {item.provider.toUpperCase()}</h4><p>Loading status: {item.status} · {item.memoryGB ? `${item.memoryGB.toFixed(2)} GB peak memory` : 'Memory not measured this session'}</p><p>Base checkpoint: {item.baseCheckpoint}</p><p>Adapter checkpoint: {item.adapterCheckpoint}</p>{item.verifiedAt && <p>Generation verified: {new Date(item.verifiedAt).toLocaleString()}</p>}{item.error && <p role="alert">{item.error}</p>}</div>)}
      </FineStep>
      {notice && !datasetOperation && <p className={`ac-notice ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{notice}</p>}
    </main><aside className="ac-fine-help"><section className="ac-panel"><h3><BookOpen size={22} />About Fine-Tuning</h3><h4>Training vs Knowledge Modules</h4><p>Fine-tuning changes how the model responds by updating adapter weights using your training data. Knowledge modules instead provide additional context from approved documents without changing model weights.</p><details><summary>Learn more about the differences</summary><p>Use knowledge for changing facts and source citations. Use a carefully evaluated adapter for repeatable response patterns. Neither automatically grants tools or proves correctness.</p></details></section><section className="ac-panel"><h3><Network size={22} />What is LoRA / QLoRA?</h3><p>LoRA (Low-Rank Adaptation) trains small adapter weights instead of the full model. QLoRA trains adapters over a compatible quantized source, reducing memory use. Architecture, source identity, and hardware must still be validated.</p><details><summary>Learn about LoRA / QLoRA</summary><p>Ollama inference artifacts cannot be trained directly here. An MLX-compatible source is required; the saved adapter remains separate from your installed model.</p></details></section><section className="ac-panel"><h3><Lightbulb size={22} />Recommended next steps</h3><ol><li>{profile?.checkpointId ? 'Review the selected source identity and license.' : 'Prepare and validate a compatible source checkpoint.'}</li><li>{profile?.datasetId ? 'Review dataset quality and held-out splits.' : 'Prepare a small, high-quality JSONL dataset.'}</li><li>{job?.adapterFiles.length ? 'Compare base and checkpoints on independent tasks.' : 'Start with a quick test to validate data and settings.'}</li><li>Review results and activate a verified adapter with native MLX inference.</li></ol><button className="button secondary" onClick={() => jump(7)}>View deployment guidance</button></section></aside></div>
  </>
}
