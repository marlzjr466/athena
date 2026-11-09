import { useEffect, useState } from 'react'
import { Check, BookOpen, Trash2 } from 'lucide-react'
import { academyModules, type AcademyCommand, type AcademyProfile, type AcademySnapshot, type AcademyProjectProgress, type AcademyIndexProgress } from '../../../shared/academy'
import { academyCourses, courseProgress, courseSourceFingerprint, courseStagePassed, courseStages, courseStageLabels, currentCourseResults } from '../../../shared/academyCourses'
import type { LocalModel } from '../../../shared/localAI'
import { desktop } from '../../services/desktop'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { Toggle } from '../../components/ui/Controls'
import { AcademyProgress } from './AcademyDesign'
import { AcademyCourseResults } from './AcademyCourseResults'

export function AcademyCourseView({ course, model, models, profile, snapshot, busy, run }: { course: typeof academyCourses[number]; model: LocalModel; models: LocalModel[]; profile: AcademyProfile; snapshot: AcademySnapshot; busy: boolean; run: (command: AcademyCommand) => Promise<void> }) {
  const record = snapshot.courses?.find(item => item.model === model.name && item.digest === model.digest && item.courseId === course.id)
  const assignments = profile.knowledgeAssignments
  const assignment = assignments?.find(item => item.courseId === course.id)
  const assignedIds = assignment?.sourceIds ?? (assignments === undefined ? profile.knowledgeIds : [])
  const assignedSources = snapshot.sources.filter(source => assignedIds.includes(source.id))
  const activeResults = currentCourseResults(record)
  const knowledgeResult = activeResults.filter(result => result.stage === 'knowledge').at(-1)
  const evidenceHashes = new Set((knowledgeResult?.evidence ?? []).map(item => item.match(/[a-f0-9]{64}$/i)?.[0]).filter((value): value is string => Boolean(value)))
  const legacyFingerprint = evidenceHashes.size ? courseSourceFingerprint(assignedSources.filter(source => evidenceHashes.has(source.sha256)), assignedSources.filter(source => evidenceHashes.has(source.sha256)).map(source => source.id)) : ''
  const currentSourceFingerprint = courseSourceFingerprint(assignedSources, assignedIds)
  const sourceChanged = Boolean(knowledgeResult?.passed && (record?.sourceFingerprint !== undefined ? record.sourceFingerprint !== currentSourceFingerprint : legacyFingerprint !== '' && legacyFingerprint !== currentSourceFingerprint))
  const passed = (item: typeof courseStages[number]) => {
    if (sourceChanged && courseStages.indexOf(item) >= courseStages.indexOf('knowledge')) return false
    return courseStagePassed(record, item)
  }
  const firstStage = sourceChanged ? 'knowledge' : courseStages.find(item => !passed(item)) ?? 'evaluation'
  const rawProgress = courseProgress(record)
  const progress = sourceChanged ? { ...rawProgress, completed: courseStages.filter(passed).length, percent: Math.round(courseStages.filter(passed).length / courseStages.length * 100), status: 'In Progress' as const } : rawProgress
  const [stage, setStage] = useState<typeof courseStages[number]>(firstStage)
  const [threshold, setThreshold] = useState(record?.threshold ?? 80)
  const [indexProgress, setIndexProgress] = useState<AcademyIndexProgress | null>(null)
  const [projectProgress, setProjectProgress] = useState<AcademyProjectProgress[]>([])
  useEffect(() => setStage(firstStage), [course.id, model.name, model.digest, record?.updatedAt, firstStage])
  useEffect(() => desktop.onAcademyProjectProgress?.(event => {
    if (event.model === model.name && event.digest === model.digest) setProjectProgress(items => [...items.slice(-19), event])
  }) ?? (() => {}), [model.name, model.digest])
  const [showLibrary, setShowLibrary] = useState(false)
  useEffect(() => desktop.onAcademyProgress?.(setIndexProgress) ?? (() => {}), [])
  const stageIndex = courseStages.indexOf(stage)
  const stagePassed = passed(stage)
  const previousDone = courseStages.slice(0, stageIndex).every(passed)
  const results = record?.results.filter(result => result.stage === stage).slice().reverse() ?? []
  const historicalResults = courseStages.map((historyStage, index) => ({ stage: historyStage, label: courseStageLabels[index], results: record?.results.filter(result => result.stage === historyStage && historyStage !== stage).slice().reverse() ?? [] })).filter(item => item.results.length)
  const descriptions = [
    'Review and install the versioned guidance below. It becomes a reusable skill for this local model; installing it does not certify the model or update its weights.',
    'Add an approved text or Markdown source, link it to this model, and build a local semantic index. Completion verifies a ready index for the currently selected embedding model.',
    'Generate a worked example using the installed guidance and approved retrieved knowledge. This records a learning artifact, not a correctness score.',
    'Run a separate practical exercise. Coding uses executable JavaScript tests in the local sandbox; other courses use narrow reference checks. Review failures before continuing.',
    'Verify the recorded foundation, knowledge, guided example, and practical checks. Final evaluation uses separate prompts, without the training guidance or retrieval context.',
    'Run independent local checks. Passing requires the configured score and all critical safety checks. These small benchmarks establish evidence only for the tested competencies—not general mastery.',
  ]
  if (course.id === 'project') {
    descriptions[0] = 'Learn project structure, filesystem boundaries, instruction precedence and agent architecture. Install reusable project guidance for this model.'
    descriptions[1] = 'Assign project documentation, command and skill references to this module and verify its own semantic index. Open Folder as Project in chat enables live project discovery and indexing tools.'
    descriptions[2] = 'Follow a supervised walkthrough of a disposable project. Athena reads the required sources, commands and scoped instructions, then helps the local model explain each lesson using real evidence. Practical training and final evaluation assess independent execution.'
    descriptions[3] = 'Practice real file CRUD and structured workflows in an isolated disposable project. Changes and tool results are checked; protected paths and confirmations remain enforced.'
    descriptions[4] = 'Verify every enabled source index, the embedding model digest and isolated command runner before independent evaluation.'
    descriptions[5] = 'Independently evaluate architecture, commands, skills, references, scoped instructions, real CRUD, workflow execution and safety in a fresh disposable project. Incorrect or simulated results fail.'
  }
  const labels = ['Install guidance & complete foundation', 'Verify knowledge index', 'Generate guided example', 'Run practical exercise', 'Check evaluation readiness', 'Run final evaluation']
  return <div className="ac-course-view">
    <div className="ac-course-progress"><AcademyProgress value={progress.percent} label="Course progress" /><span>{progress.completed} / {progress.total} stages completed</span></div>
    <nav className="ac-lesson-timeline" aria-label="Course stages">{courseStages.map((item, i) => { const selectable = item === stage || (!passed(item) && courseStages.slice(0, i).every(passed)); return <button key={item} className={stage === item ? 'active' : ''} disabled={!selectable} aria-disabled={!selectable} onClick={() => setStage(item)}><span>{passed(item) ? <Check size={16} /> : i + 1}</span>{courseStageLabels[i]}</button> })}</nav>
    <section className="ac-panel ac-lesson"><h2>{courseStageLabels[stageIndex]}</h2><p>{descriptions[stageIndex]}</p>
      {course.id === 'project' && busy && projectProgress.length > 0 && <div className="ac-guidance" role="status" aria-live="polite"><h3>Disposable project execution</h3>{projectProgress.slice(-6).map((event, index) => <p key={index}>Step {event.round} · {event.tool.replaceAll('_', ' ')} · {event.status}</p>)}</div>}
      {stage === 'foundation' && <div className="ac-guidance">{academyModules.filter(item => (course.modules as readonly string[]).includes(item.id)).map(item => <details key={item.id}><summary><BookOpen size={15} />{item.name} · v{item.version}</summary><p>{item.description}</p><p>{item.instructions}</p></details>)}</div>}
      {stage === 'knowledge' && <div className="ac-knowledge">
        <label>Local embedding model<CustomSelect ariaLabel="Academy embedding model" value={profile.embeddingModel ?? ''} options={[{ value: '', label: 'Choose a local embedding model' }, ...models.filter(item => item.capabilities.includes('embedding')).map(item => ({ value: item.name, label: item.name }))]} disabled={busy} onChange={embeddingModel => void run({ action: 'embedding-model', model: model.name, embeddingModel: embeddingModel || null })} /></label>
        <div className="ac-actions"><span>{assignedSources.length} approved source{assignedSources.length === 1 ? '' : 's'} assigned to {course.name}</span><button className="button secondary" disabled={busy} onClick={() => void run({ action: 'add-source', model: model.name, courseId: course.id })}>Add sources</button>{snapshot.sources.some(source => !assignedIds.includes(source.id)) && <button className="button secondary" disabled={busy} onClick={() => setShowLibrary(value => !value)}>{showLibrary ? 'Hide source library' : 'Assign existing source'}</button>}</div>
        {showLibrary && <label>Existing approved source<CustomSelect ariaLabel="Existing approved source" value="" options={[{ value: '', label: 'Choose a source to assign' }, ...snapshot.sources.filter(source => !assignedIds.includes(source.id)).map(source => ({ value: source.id, label: source.name }))]} disabled={busy} onChange={sourceId => { if (sourceId) { setShowLibrary(false); void run({ action: 'link-source', model: model.name, sourceId, linked: true, courseId: course.id }) } }} /></label>}
        {profile.knowledgeReview && !assignment && <p className="ac-notice" role="status">{profile.knowledgeReview} Select Add source or enable a source below to assign it to this module.</p>}
        {!assignedSources.length && <p className="ac-empty-state">No sources are assigned to {course.name} yet. Add a Markdown or text source to this module, or enable an existing source from the library below.</p>}
        {assignedSources.map(source => { const index = source.indexes.find(item => item.model === profile.embeddingModel && item.digest === models.find(item => item.name === profile.embeddingModel)?.digest && ((item.courseId === course.id && item.localModel === model.name && item.localDigest === model.digest) || (!assignment && !item.courseId))); const live = indexProgress?.sourceId === source.id && (!indexProgress.courseId || indexProgress.courseId === course.id) ? indexProgress : null; return <div className="ac-source" key={source.id}><div><strong>{source.name}</strong><p>{(source.bytes / 1024).toFixed(1)} KB · {live?.status ?? index?.status ?? 'Not indexed'} · {(live ?? index)?.indexedChunks ?? 0}/{(live ?? index)?.totalChunks ?? 0} chunks</p>{(live?.message || index?.error) && <p role="status">{live?.message ?? index?.error}</p>}</div><Toggle label={`Disable ${source.name} for ${course.name}`} checked onChange={linked => void run({ action: 'link-source', model: model.name, sourceId: source.id, linked, courseId: course.id })} /><button className="button secondary" disabled={busy || !profile.embeddingModel} onClick={() => void run({ action: 'index-source', model: model.name, sourceId: source.id, courseId: course.id })}>{index?.status === 'ready' ? 'Verify index' : 'Index'}</button><button className="button secondary" aria-label={`Remove ${source.name} from ${course.name}`} disabled={busy} onClick={() => void run({ action: 'remove-source', model: model.name, sourceId: source.id, courseId: course.id })}><Trash2 size={15} /></button></div> })}
        {busy && <button className="button secondary" onClick={() => void desktop.academyCommand({ action: 'cancel-index' })}>Cancel indexing</button>}
      </div>}
      {stage === 'evaluation' && <label className="ac-field">Passing threshold (%)<input type="number" value={threshold} min={50} max={100} onChange={event => setThreshold(Number(event.target.value))} /></label>}
      {progress.status === 'Passed' && !sourceChanged && <p className="ac-notice">This module is already passed. Add or change an assigned source before starting it again.</p>}
      {sourceChanged && <p className="ac-notice">Sources changed for this module. Re-run Knowledge Training before continuing to later stages.</p>}
      {!previousDone && !sourceChanged && <p className="ac-notice">Complete the earlier stages successfully before running this stage.</p>}
      <div className="ac-actions"><button className="button primary" disabled={busy || !previousDone || stagePassed || (progress.status === 'Passed' && !sourceChanged) || !model.capabilities.includes('completion') || !Number.isFinite(threshold) || threshold < 50 || threshold > 100} onClick={() => void run({ action: 'course-stage', model: model.name, courseId: course.id, stage, threshold })}>{busy ? 'Working locally…' : labels[stageIndex]}</button>{busy && <button className="button secondary" onClick={() => void desktop.academyCommand({ action: 'cancel-evaluation' })}>Cancel local operation</button>}{stagePassed && stageIndex < 5 && <button className="button secondary" onClick={() => setStage(courseStages[stageIndex + 1])}>Next stage</button>}</div>
      <AcademyCourseResults results={results} busy={busy} onRetry={(resultId, exerciseId) => void run({ action: 'retry-course-exercise', model: model.name, courseId: course.id, resultId, exerciseId })} onDelete={resultId => void run({ action: 'delete-course-result', model: model.name, courseId: course.id, resultId })} />
      {historicalResults.length > 0 && <details className="ac-course-history"><summary>Past training results ({historicalResults.reduce((total, item) => total + item.results.length, 0)})</summary>{historicalResults.map(item => <section key={item.stage}><h3>{item.label}</h3><AcademyCourseResults results={item.results} busy={busy} onDelete={resultId => void run({ action: 'delete-course-result', model: model.name, courseId: course.id, resultId })} /></section>)}</details>}
    </section>
  </div>
}
