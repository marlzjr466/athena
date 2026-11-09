import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAthena } from '../src/store/athenaStore'
import { defaultSettings } from '../shared/settings'
import type { Snapshot } from '../shared/contracts'
import type { AcademySnapshot } from '../shared/academy'
import { courseStages, type CourseRecord } from '../shared/academyCourses'
import { defaultTrainingSettings, type EvaluationComparison, type TrainingSnapshot } from '../shared/academyTraining'

const api = vi.hoisted(() => ({ getLocalStatus: vi.fn(), getAcademy: vi.fn(), academyCommand: vi.fn(), onAcademyProgress: vi.fn(), getAcademyTraining: vi.fn(), academyTrainingCommand: vi.fn(), onAcademyTrainingProgress: vi.fn() }))
vi.mock('../src/services/desktop', () => ({ desktop: api, isDesktop: true }))
import { AthenaAcademy } from '../src/features/athena-ai/AthenaAcademy'
import { AcademyFineTuningView } from '../src/features/athena-ai/AcademyFineTuningView'

const model = { name: 'qwen2.5:3b', size: 3_000_000_000, family: 'qwen2', capabilities: ['completion'], digest: 'abc123' }
const profile = { model: model.name, digest: model.digest, instructions: '', modules: [], knowledgeIds: [], embeddingModel: null, learnFromCorrections: false, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z' }
const snapshot: AcademySnapshot = { profiles: [profile], sources: [], evaluations: [], courses: [] }
const training: TrainingSnapshot = { runtime: { ready: true, metalAvailable: true, message: 'MLX runtime ready.' }, profiles: [{ model: model.name, modelDigest: model.digest, checkpointId: 'checkpoint', datasetId: 'dataset', checkpointLabel: 'Qwen source', datasetName: 'verified.jsonl', datasetCounts: { train: 16, valid: 2, test: 2 } }], jobs: [], comparisons: [] }
const courseRecord = (passed: boolean): CourseRecord => ({ model: model.name, digest: model.digest, courseId: 'git', threshold: 80, updatedAt: profile.updatedAt, results: courseStages.map((stage, i) => ({ id: String(i), stage, completedAt: profile.updatedAt, passed: stage === 'evaluation' ? passed : true, score: 100, checks: [], evidence: [] })) })
beforeEach(() => {
  vi.clearAllMocks()
  useAthena.setState({ snapshot: { settings: { ...defaultSettings, localAI: { ...defaultSettings.localAI, model: model.name } }, state: 'idle' } as Snapshot })
  api.getLocalStatus.mockResolvedValue({ connected: true, models: [model, { ...model, name: 'qwen2.5-coder:3b', digest: 'xyz' }, { name: 'embeddinggemma:latest', size: 600_000_000, capabilities: ['embedding'], digest: 'e'.repeat(64) }] })
  api.getAcademy.mockResolvedValue(snapshot)
  api.academyCommand.mockResolvedValue({ ok: true, snapshot })
  api.onAcademyProgress.mockReturnValue(() => {})
  api.getAcademyTraining.mockResolvedValue(training)
  api.academyTrainingCommand.mockResolvedValue({ ok: true, snapshot: training })
  api.onAcademyTrainingProgress.mockReturnValue(() => {})
})
const dashboard = async () => { render(<AthenaAcademy />); await waitFor(() => expect(screen.getByRole('combobox', { name: 'Academy model' })).toHaveValue(model.name)) }
const fine = async () => { render(<AcademyFineTuningView model={model} />); await within(screen.getByRole('region', { name: 'Training Dataset' })).findByText('verified.jsonl') }

describe('reference Academy dashboard', () => {
  it('shows eight full-width module rows with real zero progress, without old standalone panels', async () => {
    await dashboard()
    expect(screen.getAllByRole('article', { name: /training module/ })).toHaveLength(8)
    expect(screen.getByRole('progressbar', { name: 'AI Coding progress' })).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByRole('progressbar', { name: 'Model training progress' })).toHaveAttribute('aria-valuenow', '0')
    for (const name of ['Interview Practice', 'Coding Examination', 'Meeting Notes', 'Model-specific instructions']) expect(screen.queryByRole('heading', { name })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Fine-Tuning Wizard' })).toBeEnabled()
  })
  it('derives course status from persisted evaluation and filters without touching other models', async () => {
    const data = { ...snapshot, courses: [courseRecord(true)] }
    api.getAcademy.mockResolvedValue(data); api.academyCommand.mockResolvedValue({ ok: true, snapshot: data })
    await dashboard()
    expect(screen.getByRole('progressbar', { name: 'Model training progress' })).toHaveAttribute('aria-valuenow', '13')
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter training modules' }))
    fireEvent.click(screen.getByRole('option', { name: 'Passed' }))
    expect(screen.getAllByRole('article', { name: /training module/ })).toHaveLength(1)
    expect(screen.getByRole('article', { name: 'Git Intelligence training module' })).toBeInTheDocument()
    expect(within(screen.getByRole('article', { name: 'Git Intelligence training module' })).getByRole('button', { name: 'Restart Training' })).toBeEnabled()
    fireEvent.click(screen.getByRole('combobox', { name: 'Academy model' }))
    fireEvent.click(screen.getByRole('option', { name: 'qwen2.5-coder:3b' }))
    expect(screen.getByRole('progressbar', { name: 'Model training progress' })).toHaveAttribute('aria-valuenow', '0')
    expect(useAthena.getState().snapshot?.settings.localAI.model).toBe(model.name)
    expect(useAthena.getState().snapshot?.settings.aiMode).toBe(defaultSettings.aiMode)
  })
  it('opens structured training, requires previous stages, and sends a real local course command', async () => {
    await dashboard()
    fireEvent.click(within(screen.getByRole('article', { name: 'AI Coding training module' })).getByRole('button', { name: 'Start Training' }))
    expect(screen.getByRole('navigation', { name: 'Course stages' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Final Evaluation/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Install guidance & complete foundation' }))
    await waitFor(() => expect(api.academyCommand).toHaveBeenCalledWith({ action: 'course-stage', model: model.name, courseId: 'coding', stage: 'foundation', threshold: 80 }))
  })
  it('places Project Intelligence before Other Skills and opens its isolated six-stage workflow', async () => {
    const projectData = { ...snapshot, courses: [{ ...courseRecord(true), courseId: 'project', results: [{ ...courseRecord(true).results[0], stage: 'foundation' }] }] }
    api.getAcademy.mockResolvedValue(projectData); api.academyCommand.mockResolvedValue({ ok: true, snapshot: projectData })
    await dashboard()
    const rows = screen.getAllByRole('article', { name: /training module/ })
    expect(rows.at(-2)).toHaveAccessibleName('Project Intelligence & AI Agent Skills training module')
    expect(rows.at(-1)).toHaveAccessibleName('Other Skills training module')
    fireEvent.click(within(rows.at(-2)!).getByRole('button', { name: 'Continue Training' }))
    expect(within(screen.getByRole('navigation', { name: 'Course stages' })).getAllByRole('button')).toHaveLength(6)
    expect(screen.getByText(/No sources are assigned to Project Intelligence/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add sources' }))
    await waitFor(() => expect(api.academyCommand).toHaveBeenCalledWith({ action: 'add-source', model: model.name, courseId: 'project' }))
  })
  it('keeps embedding selection and indexing in the knowledge stage', async () => {
    const gitData = { ...snapshot, courses: [{ ...courseRecord(true), results: [{ ...courseRecord(true).results[0], stage: 'foundation' }] }] }
    api.getAcademy.mockResolvedValue(gitData); api.academyCommand.mockResolvedValue({ ok: true, snapshot: gitData })
    await dashboard()
    fireEvent.click(within(screen.getByRole('article', { name: 'Git Intelligence training module' })).getByRole('button', { name: 'View Details' }))
    fireEvent.click(screen.getByRole('combobox', { name: 'Academy embedding model' }))
    expect(screen.getByRole('option', { name: 'embeddinggemma:latest' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: model.name })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'embeddinggemma:latest' }))
    await waitFor(() => expect(api.academyCommand).toHaveBeenCalledWith({ action: 'embedding-model', model: model.name, embeddingModel: 'embeddinggemma:latest' }))
  })
  it('routes a failed exercise retry to the selected local course without rerunning the entire stage', async () => {
    const id = '36ea0559-74e4-435f-9cba-aa7d3b1e5664'
    const record: CourseRecord = { ...courseRecord(true), courseId: 'coding', results: [...courseRecord(true).results.slice(0, 3), { id, stage: 'practical', completedAt: profile.updatedAt, passed: false, score: 0, evidence: [], checks: [{ name: 'Code reading practice', exerciseId: 'coding-practical-1', passed: false, response: '5,5' }] }] }
    const data = { ...snapshot, courses: [record] }
    api.getAcademy.mockResolvedValue(data); api.academyCommand.mockResolvedValue({ ok: true, snapshot: data })
    await dashboard()
    fireEvent.click(within(screen.getByRole('article', { name: 'AI Coding training module' })).getByRole('button', { name: 'Continue Training' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed exercise' }))
    await waitFor(() => expect(api.academyCommand).toHaveBeenCalledWith({ action: 'retry-course-exercise', model: model.name, courseId: 'coding', resultId: id, exerciseId: 'coding-practical-1' }))
    expect(api.academyCommand.mock.calls.some(([command]) => command.action === 'course-stage')).toBe(false)
  })
  it('opens a dedicated seven-stage fine-tuning page and returns to the dashboard', async () => {
    await dashboard()
    fireEvent.click(screen.getByRole('button', { name: 'Open Fine-Tuning Wizard' }))
    expect(screen.getByRole('heading', { name: 'Advanced Model Fine-Tuning', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Fine-tuning stages' }).querySelectorAll('button')).toHaveLength(7)
    expect(screen.getByRole('region', { name: 'Activate Trained Model' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Athena Academy' }))
    expect(screen.getAllByRole('article', { name: /training module/ })).toHaveLength(8)
  })
})
describe('reference fine-tuning workflow', () => {
  it('uses separate validated datasets and shows measured counts, not reference values', async () => {
    await fine()
    expect(screen.getByText('20 examples · 16 train · 2 validation · 2 test')).toBeInTheDocument()
    const input = screen.getByLabelText('Choose JSONL training dataset')
    expect(input).toHaveAttribute('accept', expect.stringContaining('.jsonl'))
    const file = new File(['content'], 'my-training.JSONL'); Object.defineProperty(file, 'text', { value: async () => 'private training contents' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(api.academyTrainingCommand).toHaveBeenCalledWith({ action: 'dataset-import', model: model.name, fileName: 'my-training.JSONL', content: 'private training contents' }))
    fireEvent.change(screen.getByLabelText('Choose independent labeled evaluation JSONL'), { target: { files: [file] } })
    await waitFor(() => expect(api.academyTrainingCommand).toHaveBeenCalledWith(expect.objectContaining({ action: 'evaluation-import' })))
    expect(screen.getByRole('button', { name: 'Activate trained model' })).toBeDisabled()
  })
  it('rejects unsupported extensions and displays backend validation errors without losing history', async () => {
    await fine()
    fireEvent.change(screen.getByLabelText('Choose JSONL training dataset'), { target: { files: [new File(['bad'], 'bad.txt')] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('.jsonl extension')
    expect(api.academyTrainingCommand).not.toHaveBeenCalled()
    api.academyTrainingCommand.mockResolvedValue({ ok: false, snapshot: training, message: 'Row 2: missing messages or text' })
    const file = new File(['{}'], 'bad.jsonl'); Object.defineProperty(file, 'text', { value: async () => '{}' })
    fireEvent.change(screen.getByLabelText('Choose JSONL training dataset'), { target: { files: [file] } })
    expect(await screen.findByText('Row 2: missing messages or text')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Training Dataset' })).getByText('verified.jsonl')).toBeInTheDocument()
  })
  it('persists actual preset settings and starts only on explicit action', async () => {
    await fine()
    fireEvent.click(screen.getByRole('button', { name: /Quick Test/ }))
    await waitFor(() => expect(api.academyTrainingCommand).toHaveBeenCalledWith({ action: 'configure', model: model.name, settings: { ...defaultTrainingSettings, iterations: 10, checkpointEvery: 5 } }))
    expect(api.academyTrainingCommand.mock.calls.some(([command]) => command.action === 'train')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Start Training' }))
    await waitFor(() => expect(api.academyTrainingCommand).toHaveBeenCalledWith({ action: 'train', model: model.name, iterations: 10 }))
  })
  it('restores a running job and receives progress independently of the initiating render', async () => {
    api.getAcademyTraining.mockResolvedValue({ ...training, active: { model: model.name, stage: 'training', iteration: 5, iterations: 100, message: 'Iteration 5/100' } })
    await fine()
    expect(screen.getByRole('button', { name: 'Start Training' })).toBeDisabled()
    expect(screen.getByRole('progressbar', { name: 'Training progress' })).toHaveAttribute('aria-valuenow', '5')
    await act(async () => api.onAcademyTrainingProgress.mock.calls[0][0]({ model: model.name, stage: 'training', iteration: 10, iterations: 100, message: 'Iteration 10/100' }))
    expect(screen.getByRole('progressbar', { name: 'Training progress' })).toHaveAttribute('aria-valuenow', '10')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel training' }))
    await waitFor(() => expect(api.academyTrainingCommand).toHaveBeenCalledWith({ action: 'cancel' }))
  })
  it('keeps an unsupported architecture honest while all seven panels stay visible', async () => {
    render(<AcademyFineTuningView model={{ ...model, family: 'unverified-family' }} />)
    expect(await screen.findByText('Unsupported architecture')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download source checkpoint' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Start Training' })).toBeDisabled()
    expect(screen.getByRole('region', { name: 'Evaluate Trained Model' })).toBeInTheDocument()
  })
  it('preserves saved comparisons, reviews actual answers, and exports without deployment', async () => {
    const adapter = '0000075_adapters.safetensors'
    const scores = { coding: { correct: 0, total: 0, rate: 0, low: 0, high: 1 }, git: { correct: 1, total: 1, rate: 1, low: .2, high: 1 }, jira: { correct: 0, total: 0, rate: 0, low: 0, high: 1 } }
    const comparison: EvaluationComparison = {
      id: 'comparison', jobId: 'job', model: model.name, modelDigest: model.digest, createdAt: profile.createdAt, trainingDatasetId: 'dataset',
      settings: { maxSequenceLength: 1024, maxOutputTokens: 384, batchSize: 1, scoring: 'reference', tokenizerCheckpointId: 'checkpoint' },
      variants: [{ id: 'base', label: 'Original base', validationLoss: 2.5, testLoss: 3, taskScores: scores }, { id: adapter, label: 'Checkpoint 75', validationLoss: 1.5, testLoss: 2.3, taskScores: scores }],
      examples: [{ id: 'git-1', track: 'git', prompt: 'How do you inspect changes?', expected: ['git status'], answers: { base: 'Base answer: git status', [adapter]: 'Adapter answer: git status and git diff' }, correct: { base: true, [adapter]: true } }],
      warnings: ['Small independent sample: insufficient evidence for broad capability.'],
    }
    const saved: TrainingSnapshot = { ...training, jobs: [{ id: 'job', model: model.name, modelDigest: model.digest, checkpointId: 'checkpoint', datasetId: 'dataset', stage: 'completed', startedAt: profile.createdAt, finishedAt: profile.updatedAt, iteration: 100, iterations: 100, adapterFiles: [adapter, 'adapters.safetensors'], selectedAdapter: adapter }], comparisons: [comparison] }
    api.getAcademyTraining.mockResolvedValue(saved)
    api.academyTrainingCommand.mockResolvedValue({ ok: true, snapshot: saved })
    await fine()
    expect(screen.getByText('Checkpoint 75 ★')).toBeInTheDocument()
    expect(screen.getByText(/Insufficient evidence to recommend deployment/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View generated answers & details' }))
    expect(screen.getByText('Base answer: git status')).toBeInTheDocument()
    expect(screen.getByText('Adapter answer: git status and git diff')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Needs review' })[1])
    await waitFor(() => expect(api.academyTrainingCommand).toHaveBeenCalledWith({ action: 'review-example', model: model.name, comparisonId: 'comparison', exampleId: 'git-1', variantId: adapter, decision: 'needs-review', note: '' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export adapter' }))
    await waitFor(() => expect(api.academyTrainingCommand).toHaveBeenCalledWith({ action: 'export-adapter', model: model.name, jobId: 'job' }))
    expect(screen.getByRole('button', { name: 'Activate trained model' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Activate trained model' }))
    await waitFor(() => expect(api.academyTrainingCommand).toHaveBeenCalledWith({ action: 'activate-adapter', model: model.name, jobId: 'job', adapter }))
    expect(api.academyTrainingCommand.mock.calls.some(([command]) => command.action === 'train')).toBe(false)
    expect(within(screen.getByRole('region', { name: 'Training Dataset' })).getByText('verified.jsonl')).toBeInTheDocument()
  })
})


describe('manual fine-tuning dataset imports', () => {
  it('persists mode and shows 52/6/7 with inline success after imports, navigation, and remount', async () => {
    let saved: TrainingSnapshot = structuredClone(training)
    api.academyTrainingCommand.mockImplementation(async command => {
      const profile = saved.profiles[0]
      if (command.action === 'dataset-mode') {
        profile.datasetMode = command.mode; profile.datasetId = undefined; profile.datasetCounts = undefined
        profile.datasetSelections = { manual: { id: 'manual', files: {}, warnings: [] } }
      } else if (command.action === 'dataset-split-import') {
        const count = command.split === 'train' ? 52 : command.split === 'valid' ? 6 : 7
        profile.datasetSelections!.manual!.files[command.split as 'train' | 'valid' | 'test'] = { name: command.fileName, count, hash: 'hash', sourceHash: 'source', status: 'valid', origin: 'imported', importedAt: profile.modelDigest }
        profile.datasetId = 'manual'
        profile.datasetCounts ??= { train: 0, valid: 0, test: 0 }
        profile.datasetCounts[command.split as 'train' | 'valid' | 'test'] = count
      }
      saved = structuredClone(saved)
      api.getAcademyTraining.mockResolvedValue(saved)
      return { ok: true, snapshot: saved, message: command.action === 'dataset-split-import' ? `Imported ${command.fileName}: validated successfully.` : 'Manual Split selected.' }
    })
    const view = render(<AcademyFineTuningView model={model} />)
    await screen.findByText('20 examples · 16 train · 2 validation · 2 test')
    fireEvent.click(screen.getByRole('combobox', { name: 'Dataset mode' }))
    fireEvent.click(screen.getByRole('option', { name: 'Manual Split' }))
    await screen.findByText('Manual Split selected.')
    expect(screen.getByRole('button', { name: 'Start Training' })).toBeDisabled()
    for (const [split, label, section] of [['train', 'Choose JSONL training dataset', 'Training Dataset'], ['valid', 'Choose JSONL validation dataset', 'Validation Dataset'], ['test', 'Choose JSONL independent test dataset', 'Independent Test Dataset']]) {
      const file = new File(['{}'], `${split}.jsonl`)
      Object.defineProperty(file, 'text', { value: async () => 'conversation data' })
      fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } })
      await waitFor(() => expect(within(screen.getByRole('region', { name: section })).getByRole('status')).toHaveTextContent(`Imported ${split}.jsonl`))
      expect(api.academyTrainingCommand).toHaveBeenCalledWith({ action: 'dataset-split-import', model: model.name, split, fileName: `${split}.jsonl`, content: 'conversation data' })
    }
    expect(screen.getByLabelText('Dataset counts')).toHaveTextContent('65 examples · 52 train · 6 validation · 7 test')
    expect(screen.getByRole('button', { name: 'Start Training' })).toBeEnabled()
    Element.prototype.scrollIntoView = vi.fn()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Fine-tuning stages' })).getByRole('button', { name: /Configure Training/ }))
    expect(screen.getByLabelText('Dataset counts')).toHaveTextContent('52 train · 6 validation · 7 test')
    view.unmount()
    render(<AcademyFineTuningView model={model} />)
    await screen.findByText('65 examples · 52 train · 6 validation · 7 test')
    expect(screen.getByRole('combobox', { name: 'Dataset mode' })).toHaveTextContent('Manual Split')
    expect(within(screen.getByRole('region', { name: 'Independent Test Dataset' })).getByText('test.jsonl')).toBeInTheDocument()
  })
  it('shows test file read and parser failures beside the test importer', async () => {
    const saved = structuredClone(training)
    saved.profiles[0].datasetMode = 'manual'
    saved.profiles[0].datasetSelections = { manual: { id: 'manual', files: {}, warnings: [] } }
    api.getAcademyTraining.mockResolvedValue(saved)
    api.academyTrainingCommand.mockResolvedValue({ ok: false, snapshot: saved, message: 'test.jsonl: Invalid JSONL at line 3.' })
    render(<AcademyFineTuningView model={model} />)
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Dataset mode' })).toHaveTextContent('Manual Split'))
    const input = screen.getByLabelText('Choose JSONL independent test dataset')
    const file = new File(['{}'], 'test.jsonl'); Object.defineProperty(file, 'text', { value: async () => '{}' })
    fireEvent.change(input, { target: { files: [file] } })
    const section = within(screen.getByRole('region', { name: 'Independent Test Dataset' }))
    expect(await section.findByRole('alert')).toHaveTextContent('line 3')
    const unreadable = new File(['{}'], 'unreadable.jsonl'); Object.defineProperty(unreadable, 'text', { value: async () => { throw new Error('File could not be read') } })
    fireEvent.change(input, { target: { files: [unreadable] } })
    await waitFor(() => expect(section.getByRole('alert')).toHaveTextContent('File could not be read'))
    expect(screen.getByRole('button', { name: 'Start Training' })).toBeDisabled()
  })
})
