import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AcademyCourseResults } from '../src/features/athena-ai/AcademyCourseResults'
import type { CourseResult } from '../shared/academyCourses'

const result: CourseResult = { id: 'attempt1', stage: 'practical', completedAt: '2026-10-21T09:02:05.800Z', passed: false, score: 2 / 3 * 100, threshold: 80, evidence: [], checks: [
  { name: 'Code reading practice', exerciseId: 'coding-practical-1', passed: false, response: '5,5', prompt: 'What does [1,4].map(x=>x+1).join(",") return?', expectedAnswer: '2,5 (a string)', reason: 'Expected 2,5, but received 5,5.', recommendations: ['Trace each element separately.'], execution: { details: 'Deterministic full-output comparison.', actualOutput: '5,5', expectedOutput: '2,5' } },
  { name: 'Executable test: sum', exerciseId: 'coding-practical-sum', passed: true, response: 'function solve(values) { return values.reduce((a,b)=>a+b,0) }', expectedAnswer: 'The sum of the values.', execution: { details: 'Existing local sandbox.', input: '[[2,3]]', expectedOutput: '5', actualOutput: '5', durationMs: 9 } },
  { name: 'Executable test: empty sum', exerciseId: 'coding-practical-sum', passed: true, response: 'function solve(values) { return values.reduce((a,b)=>a+b,0) }', execution: { details: 'Existing local sandbox.', input: '[[]]', expectedOutput: '0', actualOutput: '0' } },
] }
describe('Academy per-exercise reports', () => {
  it('shows a readable guided explanation, a specific diagnostic and expandable actual evidence', () => {
    const check = { ...result.checks[0], name: 'Scoped instruction precedence', exerciseId: 'project-guided-scenario', response: 'The nested UI instruction overrides the root rule.', reason: 'The explanation still needs: the permission boundary.', detail: 'Supervised worked example.', execution: { details: 'Real read-only tools.', actualOutput: 'inspect_project_instructions: src/ui/AGENTS.md' } }
    const { container } = render(<AcademyCourseResults results={[{ ...result, stage: 'guided', checks: [check] }]} busy={false} onRetry={vi.fn()} />)
    expect(screen.getByText(check.response)).toBeInTheDocument()
    expect(screen.getByText(check.reason)).toBeInTheDocument()
    expect(screen.getByText('View lesson evidence')).toBeInTheDocument()
    expect(container.querySelector('.ac-check details')).not.toHaveAttribute('open')
    expect(screen.getByText(check.execution.actualOutput)).toBeInTheDocument()
  })
  it('shows two-decimal scores and complete failure evidence alongside the expected answer', () => {
    const onRetry = vi.fn()
    render(<AcademyCourseResults results={[result]} busy={false} onRetry={onRetry} />)
    expect(screen.getByText('66.67% · Failed')).toBeInTheDocument()
    expect(screen.queryByText(/66\.666/)).not.toBeInTheDocument()
    const reading = within(screen.getByRole('article', { name: 'Code reading practice' }))
    for (const name of ['Original question / task', 'Expected answer', 'Actual local model response', 'Reason for failure', 'Test execution details', 'Recommended improvements']) expect(reading.getByRole('heading', { name })).toBeInTheDocument()
    expect(reading.getByText(result.checks[0].prompt!)).toBeInTheDocument()
    expect(reading.getByText('2,5 (a string)')).toBeInTheDocument()
    expect(reading.getByText('Expected 2,5, but received 5,5.')).toBeInTheDocument()
    expect(reading.getByText('Trace each element separately.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Retry failed exercise' })).toHaveLength(1)
    fireEvent.click(reading.getByRole('button', { name: 'Retry failed exercise' }))
    expect(onRetry).toHaveBeenCalledWith(result.id, 'coding-practical-1')
    const sum = within(screen.getByRole('article', { name: 'Executable test: sum' }))
    expect(sum.getByText('[[2,3]]')).toBeInTheDocument()
    expect(sum.getByText('9 ms')).toBeInTheDocument()
    expect(sum.queryByRole('button')).not.toBeInTheDocument()
  })
  it('labels retained evidence and practice retries, while keeping previous attempts expandable', () => {
    const retry: CourseResult = { ...result, id: 'attempt2', attemptKind: 'practice-retry', retryOf: result.id, checks: result.checks.map(check => ({ ...check, sourceResultId: result.id, evaluatedAt: result.completedAt, legacyMetadata: true })) }
    const { container } = render(<AcademyCourseResults results={[retry, result]} busy={true} onRetry={vi.fn()} />)
    expect(screen.getByText(/Practice retry · retained results/)).toHaveTextContent('not an independent final evaluation')
    expect(screen.getAllByText(/Retained from a previous attempt/)).toHaveLength(3)
    expect(screen.getAllByText(/Historical result/)).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Retry failed exercise' })).toBeDisabled()
    expect(container.querySelectorAll('.ac-result')).toHaveLength(2)
    expect(container.querySelectorAll('.ac-result[open]')).toHaveLength(0)
  })
  it('does not offer single-exercise retry for final evaluation or previously passed checks', () => {
    render(<AcademyCourseResults results={[{ ...result, stage: 'evaluation' }]} busy={false} onRetry={vi.fn()} />)
    expect(screen.getByText(/Independent final evaluation/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry failed exercise' })).not.toBeInTheDocument()
  })
  it('offers deletion for failed historical results and keeps passed results protected', () => {
    const onDelete = vi.fn()
    render(<AcademyCourseResults results={[result, { ...result, id: 'passed-attempt', passed: true }]} busy={false} onRetry={vi.fn()} onDelete={onDelete} />)
    expect(screen.getAllByRole('button', { name: 'Delete failed result' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Delete failed result' }))
    expect(onDelete).toHaveBeenCalledWith(result.id)
  })
  it('shows only one retry button for all tests of a generated solution', () => {
    render(<AcademyCourseResults results={[{ ...result, checks: result.checks.map((check, i) => ({ ...check, passed: i === 0 })) }]} busy={false} onRetry={vi.fn()} />)
    expect(screen.getAllByRole('button', { name: 'Retry failed exercise' })).toHaveLength(1)
    expect(within(screen.getByRole('article', { name: 'Executable test: sum' })).getByRole('button')).toBeInTheDocument()
  })
  it('renders model output as text, not executable markup', () => {
    const { container } = render(<AcademyCourseResults results={[{ ...result, checks: [{ ...result.checks[0], response: '<script>bad()</script>' }] }]} busy={false} onRetry={vi.fn()} />)
    expect(screen.getByText('<script>bad()</script>')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
  })
})
