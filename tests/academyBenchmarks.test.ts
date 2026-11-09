import { describe, expect, it } from 'vitest'
import { refreshComparison, scoreReference } from '../electron/main/ai/academyBenchmarks'
import type { EvaluationComparison, EvaluationExample } from '../shared/academyTraining'

const example = (track: EvaluationExample['track'], required: string[], forbidden: string[] = []): EvaluationExample => ({ id: '1', track, prompt: 'Explain the result', expected: ['A reference answer'], required, forbidden, answers: {}, correct: {} })

describe('independent benchmark scoring', () => {
  it('selects manual checkpoints by validation loss even when test losses favor another checkpoint', () => {
    const comparison: EvaluationComparison = { id: 'manual', jobId: 'job', model: 'model', createdAt: '', trainingDatasetId: 'manual', selectionBasis: 'validation', settings: { maxSequenceLength: 1024, maxOutputTokens: 384, batchSize: 1, scoring: 'validation', tokenizerCheckpointId: 'checkpoint' }, examples: [], variants: [
      { id: 'base', label: 'Base', validationLoss: 3, testLoss: 3, taskScores: {} as EvaluationComparison['variants'][number]['taskScores'] },
      { id: 'best-validation', label: 'Validation best', validationLoss: 1, testLoss: 100, taskScores: {} as EvaluationComparison['variants'][number]['taskScores'] },
      { id: 'best-test', label: 'Test best', validationLoss: 2, testLoss: .01, taskScores: {} as EvaluationComparison['variants'][number]['taskScores'] },
    ], warnings: [] }
    refreshComparison(comparison)
    expect(comparison.recommendation).toBe('best-validation')
  })
  it('checks required and prohibited Git/Jira facts and explains concrete failures', () => {
    const git = example('git', ['git status', 'review the diff'], ['force push'])
    expect(scoreReference(git, 'Run git status and review the diff.').status).toBe('pass')
    expect(scoreReference(git, 'Run git status, then force push.')).toMatchObject({ status: 'fail' })
    expect(scoreReference(git, 'Run git status.').reason).toContain('review the diff')
    const jira = example('jira', ['acceptance criteria', 'test evidence'])
    expect(scoreReference(jira, 'Check acceptance criteria and attach test evidence.').status).toBe('pass')
    expect(scoreReference(jira, 'Attach a screenshot.').status).toBe('fail')
  })
  it('flags legacy reference-only nonmatches for review rather than pretending semantic certainty', () => {
    const row = example('jira', [])
    expect(scoreReference(row, 'A reference answer').status).toBe('pass')
    expect(scoreReference(row, 'A plausible paraphrase').status).toBe('needs-review')
  })
  it('ranks all three measured tracks with loss and holds recommendations while reviews are pending', () => {
    const rows = (['coding', 'git', 'jira'] as const).map((track, index) => ({ ...example(track, []), id: String(index), ...(track === 'coding' ? { tests: [{ name: 'case', args: [], expected: 1 }] } : {}), judgements: { base: { status: 'fail' as const, reason: 'failed' }, checkpoint: { status: 'pass' as const, reason: 'passed' } } }))
    const comparison: EvaluationComparison = { id: 'compare', jobId: 'job', model: 'model', createdAt: '', trainingDatasetId: 'training', evaluationDatasetId: 'independent', settings: { maxSequenceLength: 1024, maxOutputTokens: 384, batchSize: 1, scoring: 'tests', tokenizerCheckpointId: 'checkpoint' }, examples: rows, variants: [
      { id: 'base', label: 'Base', validationLoss: 1.5, testLoss: 2.4, taskScores: {} as EvaluationComparison['variants'][number]['taskScores'] },
      { id: 'checkpoint', label: 'Checkpoint', validationLoss: 1.2, testLoss: 2.1, taskScores: {} as EvaluationComparison['variants'][number]['taskScores'] },
    ], warnings: [] }
    refreshComparison(comparison)
    expect(comparison.recommendation).toBe('checkpoint')
    expect(comparison.variants[1].taskScores.git.rate).toBe(1)
    rows[1].reviews = { checkpoint: { decision: 'needs-review', note: 'Ambiguous', reviewedAt: '' } }
    refreshComparison(comparison)
    expect(comparison.recommendation).toBeUndefined()
    expect(comparison.variants[1].taskScores.git.needsReview).toBe(1)
  })
})
