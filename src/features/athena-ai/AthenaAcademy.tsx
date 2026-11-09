import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, BookOpen, Box, Braces, CheckCircle2, ChevronRight, Circle, Clock3, Code2, GitBranch, Layers3, LoaderCircle, PanelsTopLeft, Rocket, SlidersHorizontal, Star, XCircle } from 'lucide-react'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { desktop } from '../../services/desktop'
import { useAthena } from '../../store/athenaStore'
import { type AcademyCommand, type AcademySnapshot } from '../../../shared/academy'
import { academyCourses, courseProgress, courseSourceFingerprint, courseStagePassed, courseStages, currentCourseResults, type CourseId, type CourseStatus } from '../../../shared/academyCourses'
import type { LocalStatus } from '../../../shared/localAI'
import { AcademyHeader, AcademyModelPanel, AcademyProgress, AcademyStatus } from './AcademyDesign'
import { AcademyCourseView } from './AcademyCourseView'
import { AcademyTrainingPanel } from './AcademyTrainingPanel'
import '../../styles/academy.css'

const empty: AcademySnapshot = { profiles: [], sources: [], evaluations: [], courses: [] }
const icons = { code: Code2, git: GitBranch, jira: PanelsTopLeft, braces: Braces, layers: Layers3, box: Box, star: Star }
export const courseTone = (status: CourseStatus) => status === 'Passed' ? 'success' : status === 'Failed' ? 'danger' : status === 'Ready for Evaluation' || status === 'Needs Review' ? 'warning' : status === 'In Progress' ? 'blue' : 'neutral'
export function AthenaAcademy() {
  const activeModel = useAthena(state => state.snapshot?.settings.localAI.model)
  const [status, setStatus] = useState<LocalStatus | null>(null)
  const [data, setData] = useState<AcademySnapshot>(empty)
  const [model, setModel] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeVisible, setNoticeVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'dashboard' | 'fine' | CourseId>('dashboard')
  const [filter, setFilter] = useState('all')
  const [help, setHelp] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.closest('.main-content')?.scrollTo({ top: 0 }) }, [view])
  useEffect(() => {
    let alive = true
    void Promise.all([desktop.getLocalStatus(), desktop.getAcademy()]).then(([local, academy]) => {
      if (!alive) return
      setStatus(local); setData(academy)
      setModel(current => current || (local.models.some(item => item.name === activeModel) ? activeModel! : local.models.find(item => item.capabilities.includes('completion'))?.name ?? local.models[0]?.name ?? ''))
    }).catch(() => { if (alive) setNotice('Academy could not load local model information.') })
    return () => { alive = false }
  }, [activeModel])
  useEffect(() => {
    if (!model) return
    let alive = true
    void desktop.academyCommand({ action: 'profile', model }).then(result => { if (alive) { setData(result.snapshot); if (!result.ok) setNotice(result.message ?? 'Could not open the model profile.') } }).catch(() => { if (alive) setNotice('Could not open the model profile.') })
    return () => { alive = false }
  }, [model])
  useEffect(() => {
    if (!notice) { setNoticeVisible(false); return }
    setNoticeVisible(true)
    const timeout = window.setTimeout(() => setNoticeVisible(false), 5000)
    return () => window.clearTimeout(timeout)
  }, [notice])
  const run = async (command: AcademyCommand) => {
    setBusy(true); setNotice('')
    try { const result = await desktop.academyCommand(command); setData(result.snapshot); setNotice(result.message ?? (result.ok ? 'Saved to this local model profile.' : 'Operation did not complete.')) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Academy could not complete this operation.') }
    finally { setBusy(false) }
  }
  const selected = status?.models.find(item => item.name === model)
  const profile = data.profiles.find(item => item.model === model)
  const records = data.courses?.filter(item => item.model === model && item.digest === selected?.digest) ?? []
  const sourceChanged = (courseId: CourseId, record: typeof records[number] | undefined) => {
    const activeResults = currentCourseResults(record)
    const knowledge = activeResults.filter(result => result.stage === 'knowledge').at(-1)
    if (!profile || !record || !knowledge?.passed) return false
    const assignment = profile.knowledgeAssignments?.find(item => item.courseId === courseId)
    const sourceIds = assignment?.sourceIds ?? (profile.knowledgeAssignments === undefined ? profile.knowledgeIds : [])
    const assigned = data.sources.filter(source => sourceIds.includes(source.id))
    const current = courseSourceFingerprint(assigned, sourceIds)
    if (record.sourceFingerprint !== undefined) return record.sourceFingerprint !== current
    const hashes = new Set((knowledge.evidence ?? []).map(item => item.match(/[a-f0-9]{64}$/i)?.[0]).filter((value): value is string => Boolean(value)))
    if (!hashes.size) return false
    const legacy = assigned.filter(source => hashes.has(source.sha256))
    return courseSourceFingerprint(legacy, legacy.map(source => source.id)) !== current
  }
  const rows = academyCourses.map(course => {
    const record = records.find(item => item.courseId === course.id)
    const raw = courseProgress(record)
    const stale = sourceChanged(course.id, record)
    const foundationPassed = courseStagePassed(record, 'foundation')
    return { course, progress: stale ? { ...raw, completed: foundationPassed ? 1 : 0, percent: Math.round((foundationPassed ? 1 : 0) / courseStages.length * 100), status: 'In Progress' as const } : raw }
  })
  const passed = rows.filter(row => row.progress.status === 'Passed').length
  const overall = Math.round(passed / rows.length * 100)
  const summary = [
    { label: 'Total Modules', count: rows.length, sub: 'Available subjects', icon: BookOpen, color: 'purple' },
    { label: 'Not Started', count: rows.filter(row => row.progress.status === 'Not Started').length, sub: 'Modules', icon: Circle, color: 'neutral' },
    { label: 'In Progress', count: rows.filter(row => row.progress.status === 'In Progress' || row.progress.status === 'Needs Review').length, sub: `${rows.filter(row => row.progress.status === 'Needs Review').length} need review`, icon: LoaderCircle, color: 'blue' },
    { label: 'Ready for Evaluation', count: rows.filter(row => row.progress.status === 'Ready for Evaluation').length, sub: 'Modules', icon: Clock3, color: 'yellow' },
    { label: 'Passed', count: passed, sub: 'Modules', icon: CheckCircle2, color: 'green' },
    { label: 'Failed', count: rows.filter(row => row.progress.status === 'Failed').length, sub: 'Modules', icon: XCircle, color: 'red' },
  ]
  const course = academyCourses.find(item => item.id === view)
  return <div className="academy-design" ref={root}>
    <AcademyHeader fine={view === 'fine'} />
    {view === 'fine' && selected ? <AcademyTrainingPanel key={`${model}:${selected.digest}`} model={selected} models={status?.models ?? []} onModelChange={setModel} onBack={() => setView('dashboard')} /> : <>
      <div className="ac-section-heading"><div><h2>{course ? course.name : 'Athena Academy'}</h2><p>{course ? 'Structured local training · independently recorded for this model and digest.' : 'Structured training for your local AI model. Complete lessons, practice real tasks, and pass evaluations to unlock reliable skills.'}</p></div><button className="button secondary" onClick={() => course ? setView('dashboard') : setHelp(!help)}>{course ? <ArrowLeft size={15} /> : <BookOpen size={15} />}{course ? 'Back to Academy' : 'Learn how it works'}</button></div>
      {help && !course && <aside className="ac-panel ac-explanation"><h3>Learn, practice, then verify</h3><p>Foundation installs reusable skill guidance. Knowledge Training indexes only sources you explicitly approve. Guided Learning uses that knowledge locally; Practical Training records checkable exercises. Independent final checks determine Pass or Fail—not timers, installed packs, or the model’s own confidence.</p><p>These courses do not change model weights. Fine-tuning is a separate MLX workflow below. A small set of passed checks is evidence for those tasks only, not general mastery.</p></aside>}
      <AcademyModelPanel model={selected} models={status?.models ?? []} onChange={setModel} disabled={busy}><label>Model training progress</label><div className="ac-percent"><AcademyProgress value={overall} label="Model training progress" color="green" /><strong>{overall}%</strong></div><small>{passed} / {rows.length} modules passed</small></AcademyModelPanel>
      {!status && <p className="ac-notice" role="status">Discovering installed local models…</p>}
      {status && !status.connected && <p className="ac-notice" role="status">Ollama is unavailable. Start it to configure or evaluate installed models.</p>}
      {course && selected && profile ? <AcademyCourseView key={`${model}:${course.id}:${selected.digest}`} course={course} model={selected} models={status?.models ?? []} profile={profile} snapshot={data} busy={busy} run={run} /> : <>
        <div className="ac-section-heading"><div><h2>Training overview</h2><p>Progress and results for the selected local model.</p></div></div>
        <div className="ac-summary">{summary.map(item => <article className="ac-panel" key={item.label}><span className={`ac-mini-icon ${item.color}`}><item.icon size={20} /></span><div><h3>{item.label}</h3><strong>{item.count}</strong><p>{item.sub}</p></div></article>)}</div>
        <div className="ac-section-heading"><div><h2>Training modules</h2><p>Each module teaches specific skills through lessons, practical tasks, and evaluations. Complete a module to verify its checks for the selected model.</p></div><CustomSelect ariaLabel="Filter training modules" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All Modules' }, ...(['Not Started', 'In Progress', 'Ready for Evaluation', 'Passed', 'Failed', 'Needs Review'] as const).map(value => ({ value, label: value })), ...[...new Set(academyCourses.map(item => item.category))].map(value => ({ value, label: `${value} modules` }))]} /></div>
        <div className="ac-module-list">{rows.filter(row => filter === 'all' || row.progress.status === filter || row.course.category === filter).map(({ course: item, progress }) => { const Icon = icons[item.icon]; return <article className="ac-module-card ac-panel" key={item.id} aria-label={`${item.name} training module`}>
          <div className="ac-module-info"><div className={`ac-icon ${item.color}`}><Icon size={28} /></div><div><h3>{item.name}</h3><p>{item.description}</p><div className="ac-chips">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div></div></div>
          <div className="ac-module-progress"><span className="ac-level">Level: {item.level}</span><div className="ac-percent"><AcademyProgress value={progress.percent} label={`${item.name} progress`} color={item.color} /><strong>{progress.percent}%</strong></div><small>{progress.completed} / {progress.total} stages completed</small></div>
          <AcademyStatus tone={courseTone(progress.status)}>{progress.status}</AcademyStatus><div className="ac-module-actions"><button className="button primary" disabled={!selected || busy || !status?.connected || !selected.capabilities.includes('completion')} onClick={() => setView(item.id)}>{progress.status === 'Passed' ? 'Review Training' : progress.completed ? 'Continue Training' : 'Start Training'}</button><button className="button secondary" disabled={!selected} onClick={() => setView(item.id)}>View Details</button><button className="button secondary" disabled={busy || !['Ready for Evaluation', 'Passed', 'Failed'].includes(progress.status)} onClick={() => setView(item.id)}>{progress.status === 'Ready for Evaluation' ? 'Start Evaluation' : 'Evaluate'}</button><button className="button secondary" disabled={!selected || busy || !status?.connected || !selected.capabilities.includes('completion')} onClick={() => { setView(item.id); void run({ action: 'restart-course', model, courseId: item.id }) }}>Restart Training</button></div>
        </article> })}</div>
        {rows.every(row => filter !== 'all' && row.progress.status !== filter && row.course.category !== filter) && <p className="ac-notice">No modules match this filter.</p>}
        <div className="ac-section-heading ac-advanced-heading"><div className="ac-title-icon"><Rocket size={24} /><div><h2>Advanced Model Fine-Tuning</h2><p>Fine-tuning helps customize how your local model responds using carefully prepared training examples. This is different from adding documents to its knowledge library.</p></div></div><button className="button secondary" onClick={() => setView('fine')} disabled={!selected}><BookOpen size={15} />Learn about LoRA / QLoRA</button></div>
        <section className="ac-panel ac-fine-entry"><SlidersHorizontal size={26} /><div><h3>Train a custom adapter for the selected model</h3><p>Use LoRA or QLoRA to improve specific skills, behaviors, or domain knowledge with your own training datasets.</p></div><button className="button primary" disabled={!selected} onClick={() => setView('fine')}>Open Fine-Tuning Wizard <ChevronRight size={15} /></button></section>
      </>}
    </>}
    {notice && <p className={`ac-notice ac-toast ${noticeVisible ? '' : 'is-hidden'}`} role="status" aria-hidden={!noticeVisible}>{notice}</p>}
  </div>
}
