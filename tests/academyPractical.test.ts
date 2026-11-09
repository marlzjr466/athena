// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcademyService, extractRunnableSolution } from '../electron/main/ai/academyService'
import { courseExercises, scoreCourseReference } from '../electron/main/ai/academyCourseChecks'
import { academyCommandSchema } from '../shared/academy'
import { courseResultSchema, formatCourseScore, scoreCourseChecks, type CourseResult } from '../shared/academyCourses'
import type { LocalModel } from '../shared/localAI'
import type { Case } from '../electron/main/ai/codingPractice'
import { OllamaService } from '../electron/main/ai/ollamaService'

const paths: string[] = []
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }) })
const model: LocalModel = { name: 'qwen2.5-coder:3b', digest: 'qwen-version-1', size: 1, capabilities: ['completion'] }
const now = '2026-10-21T09:02:05.800Z'
const historical = (): CourseResult => ({ id: randomUUID(), stage: 'practical', completedAt: now, passed: false, score: 2 / 3 * 100, evidence: [], checks: [
  { name: 'Code reading practice', passed: false, response: '5,5', detail: 'Reference-scored response' },
  { name: 'Executable test: sum', passed: true, response: 'function solve(values) { return values.reduce((a,b)=>a+b,0) }', detail: '5' },
  { name: 'Executable test: empty sum', passed: true, response: 'function solve(values) { return values.reduce((a,b)=>a+b,0) }', detail: '0' },
] })
async function fixture(base = historical()) {
  const directory = await mkdtemp(join(tmpdir(), 'athena-exercise-test-')); paths.push(directory)
  const original = { version: 1, profiles: [], sources: [], evaluations: [], corrections: [], courses: [{ model: model.name, digest: model.digest, courseId: 'coding', threshold: 80, updatedAt: now, results: [
    ...(['foundation', 'knowledge', 'guided'] as const).map(stage => ({ id: randomUUID(), stage, completedAt: now, passed: true, score: 100, checks: [], evidence: ['Existing prerequisite evidence'] })), base,
  ] }] }
  await writeFile(join(directory, 'academy.json'), JSON.stringify(original))
  const call = vi.fn(async (_endpoint: string, _body?: unknown, _signal?: AbortSignal) => new Response(JSON.stringify({ message: { content: '"2, 5"' } })))
  const ollama = { call, modelDetails: async () => model }
  const runCases = vi.fn(async (_code: string, cases: Case[], _signal: AbortSignal) => cases.map(test => ({ name: test.name, passed: true, detail: JSON.stringify(test.expected) })))
  const service = new AcademyService(directory, ollama, { runCases })
  const latest = () => service.snapshot().courses![0].results.at(-1)!
  return { service, directory, ollama, call, runCases, base, original, latest }
}

describe('deterministic code-reading scoring', () => {
  const exercise = courseExercises('coding', 'practical')[0]
  it.each(['2,5', ' 2, 5 ', '"2,5"', "'2,5'", '`2,5`', '**2,5**', '“2,5”', '```text\n2, 5\n```', '```json\n{"answer":"2,5"}\n```'])('accepts equivalent presentation: %s', answer => {
    expect(scoreCourseReference(exercise, answer).passed).toBe(true)
  })
  it.each(['5,5', '5,2', '[2,5]', '2,5,7', '12,5', '2,50', '2,5 or 5,5', 'Not 2,5', '2,5\nActually 5,5', '{"answer":"2,5","alternative":"5,5"}', '{"answer":[2,5]}', ''])('rejects wrong or ambiguous answers: %s', answer => {
    expect(scoreCourseReference(exercise, answer).passed).toBe(false)
  })
  it('formats display only, without rounding the internal threshold comparison', () => {
    expect(formatCourseScore(2 / 3 * 100)).toBe('66.67%')
    expect(formatCourseScore(100)).toBe('100.00%')
    expect(formatCourseScore(0)).toBe('0.00%')
  })
  it('extracts a fenced solve function from explanatory local-model output', () => {
    const answer = 'Certainly! Here is the implementation:\n\n```javascript\nfunction solve(values) { return values.reduce((a, b) => a + b, 0) }\n```\n\nThis starts at zero.'
    expect(extractRunnableSolution(answer)).toBe('function solve(values) { return values.reduce((a, b) => a + b, 0) }')
  })
  it('aggregates passed, failed, execution-error, and not-run without turning not-run into a pass', () => {
    const check = (passed: boolean, status: 'passed' | 'failed' | 'not-run' | 'execution-error') => ({ name: status, response: '', passed, status })
    expect(scoreCourseChecks([check(true, 'passed'), check(true, 'passed'), check(false, 'failed')], 80).score).toBeCloseTo(200 / 3, 10)
    expect(scoreCourseChecks([check(true, 'passed'), check(true, 'passed'), check(false, 'failed')], 80).passed).toBe(false)
    expect(scoreCourseChecks([check(true, 'passed'), check(true, 'passed'), check(true, 'passed')], 80)).toEqual({ score: 100, passed: true })
    expect(scoreCourseChecks([check(false, 'failed'), check(false, 'failed'), check(false, 'failed')], 80)).toEqual({ score: 0, passed: false })
    expect(scoreCourseChecks([check(true, 'passed'), check(true, 'passed'), check(false, 'not-run')], 80)).toEqual({ score: 100, passed: false })
    expect(scoreCourseChecks([check(false, 'execution-error')], 80)).toEqual({ score: 0, passed: false })
  })
  it('uses the final-evaluation threshold for non-critical misses while preserving critical gates', () => {
    const checks = [
      { name: 'passed-1', response: '', passed: true, status: 'passed' as const },
      { name: 'passed-2', response: '', passed: true, status: 'passed' as const },
      { name: 'passed-3', response: '', passed: true, status: 'passed' as const },
      { name: 'passed-4', response: '', passed: true, status: 'passed' as const },
      { name: 'passed-5', response: '', passed: true, status: 'passed' as const },
      { name: 'non-critical-miss', response: '', passed: false, status: 'failed' as const },
    ]
    expect(scoreCourseChecks(checks, 80, { allowNonCriticalFailures: true })).toEqual({ score: 5 / 6 * 100, passed: true })
    expect(scoreCourseChecks(checks, 95, { allowNonCriticalFailures: true })).toEqual({ score: 5 / 6 * 100, passed: false })
    expect(scoreCourseChecks(checks.map((check, index) => index === 5 ? { ...check, critical: true } : check), 80, { allowNonCriticalFailures: true })).toEqual({ score: 5 / 6 * 100, passed: false })
  })
})

describe('persistent practical exercise evidence and targeted retries', () => {
  it.runIf(process.env.ATHENA_ACADEMY_LIVE_TEST === '1')('runs the coding practical end-to-end against the installed local model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athena-live-practical-')); paths.push(directory)
    const ollama = new OllamaService(() => 'http://127.0.0.1:11434')
    const liveModel = await ollama.modelDetails('qwen2.5-coder:3b')
    const live: LocalModel = { ...liveModel, digest: 'live-regression-check', capabilities: liveModel.capabilities.includes('completion') ? liveModel.capabilities : [...liveModel.capabilities, 'completion'] }
    const prerequisite = (stage: 'foundation' | 'knowledge' | 'guided') => ({ id: randomUUID(), stage, completedAt: now, passed: true, score: 100, checks: [], evidence: ['live test prerequisite'] })
    await writeFile(join(directory, 'academy.json'), JSON.stringify({ version: 1, profiles: [], sources: [], evaluations: [], corrections: [], courses: [{ model: live.name, digest: live.digest, courseId: 'coding', threshold: 80, updatedAt: now, results: [prerequisite('foundation'), prerequisite('knowledge'), prerequisite('guided')] }] }))
    const service = new AcademyService(directory, ollama)
    await service.courseStage(live, 'coding', 'practical')
    const result = service.snapshot().courses?.[0].results.at(-1)
    expect(result?.checks).toHaveLength(3)
    expect(result?.checks.every(check => ['passed', 'failed', 'execution-error'].includes(check.status ?? ''))).toBe(true)
    expect(result?.score).toBeGreaterThanOrEqual(0)
    expect(result?.score).toBeLessThanOrEqual(100)
    console.log(JSON.stringify({ model: live.name, score: result?.score, passed: result?.passed, checks: result?.checks.map(check => ({ name: check.name, status: check.status, actual: check.execution?.actualOutput, error: check.execution?.error })) }))
  }, 120_000)

  it('restores known historical task details without altering any saved verdict or score', async () => {
    const { latest, base, directory, ollama } = await fixture()
    const enriched = latest()
    expect(enriched.score).toBe(base.score)
    expect(enriched.passed).toBe(false)
    expect(enriched.checks.map(check => check.passed)).toEqual([false, true, true])
    expect(enriched.checks[0]).toMatchObject({ response: '5,5', expectedAnswer: '2,5 (a string)', legacyMetadata: true, scoringVersion: 1 })
    expect(enriched.checks[0].prompt).toContain('[1,4].map')
    expect(enriched.checks[0].reason).toContain('5,5')
    expect(enriched.checks.slice(1).map(check => check.status)).toEqual(['passed', 'passed'])
    expect(enriched.checks[1].execution).toMatchObject({ input: '[[2,3]]', expectedOutput: '5', actualOutput: '5' })
    expect(new AcademyService(directory, ollama).snapshot().courses![0].results.at(-1)).toEqual(enriched)
    expect(courseResultSchema.parse(enriched)).toEqual(enriched)
  })
  it('does not retroactively pass an old formatting-only failure', async () => {
    const base = historical(); base.checks[0].response = '"2,5"'
    const { latest } = await fixture(base)
    expect(latest().passed).toBe(false)
    expect(latest().checks[0].reason).toContain('historical score is unchanged')
  })
  it('restores execution-error status for historical sandbox failures', async () => {
    const base = historical()
    base.checks[1].execution = { details: 'Historical sandbox failure', error: "SyntaxError: Unexpected token '!'" }
    base.checks[2].execution = { details: 'Historical sandbox failure', error: "SyntaxError: Unexpected token '!'" }
    const { latest } = await fixture(base)
    expect(latest().checks.slice(1).map(check => check.status)).toEqual(['execution-error', 'execution-error'])
  })
  it('retries only the failed reading exercise, retains executable results, and persists both attempts', async () => {
    const { service, latest, base, call, runCases, directory, ollama } = await fixture()
    const before = latest()
    await service.retryCourseExercise(model, 'coding', base.id, 'coding-practical-1')
    const result = latest()
    expect(call).toHaveBeenCalledTimes(1)
    expect(runCases).not.toHaveBeenCalled()
    expect(call.mock.calls[0][1]).toMatchObject({ model: model.name, messages: [{ role: 'system' }, { role: 'user', content: before.checks[0].prompt }], options: { temperature: 0, num_predict: 512 } })
    expect((call.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages[0].content).toContain('exact JavaScript semantics')
    expect((call.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages[0].content).not.toContain('2,5')
    expect((call.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages[0].content).not.toContain('2,5')
    expect(result).toMatchObject({ stage: 'practical', attemptKind: 'practice-retry', retryOf: base.id, retriedExerciseId: 'coding-practical-1', score: 100, passed: true, threshold: 80 })
    expect(result.checks.slice(1)).toEqual(before.checks.slice(1))
    expect(result.checks[0].sourceResultId).toBe(result.id)
    expect(service.snapshot().courses![0].results[3]).toEqual(before)
    expect(new AcademyService(directory, ollama).snapshot()).toEqual(service.snapshot())
    expect(courseResultSchema.parse(result)).toEqual(result)
  })
  it('keeps an incorrect retry failed and does not pass the module', async () => {
    const { service, base, call, latest } = await fixture()
    call.mockResolvedValue(new Response(JSON.stringify({ message: { content: '5,5' } })))
    await service.retryCourseExercise(model, 'coding', base.id, 'coding-practical-1')
    expect(latest()).toMatchObject({ passed: false, score: 2 / 3 * 100 })
    expect(service.snapshot().courses![0].results.some(result => result.stage === 'evaluation')).toBe(false)
  })
  it('regenerates only the failed coding solution and reruns every test belonging to that solution', async () => {
    const base = historical(); base.checks[0].passed = true; base.checks[0].response = '2,5'; base.checks[2].passed = false
    const { service, latest, call, runCases } = await fixture(base)
    const before = latest()
    const answer = '```js\nfunction solve(values) { return values.reduce((a,b)=>a+b,0) }\n```'
    call.mockResolvedValue(new Response(JSON.stringify({ message: { content: answer } })))
    await service.retryCourseExercise(model, 'coding', base.id, 'coding-practical-sum')
    expect(call).toHaveBeenCalledTimes(1)
    expect(runCases).toHaveBeenCalledTimes(1)
    expect(runCases.mock.calls[0][1].map(test => test.name)).toEqual(['sum', 'empty sum'])
    expect(latest().checks[0]).toEqual(before.checks[0])
    expect(latest().checks[1]).toMatchObject({ response: answer, execution: { input: '[[2,3]]', expectedOutput: '5', actualOutput: '5' } })
    expect(latest().checks[1].execution?.code).not.toContain('```')
  })
  it('counts a prose-wrapped but valid sum implementation as two executable passes', async () => {
    const { service, call, runCases, latest } = await fixture()
    call.mockImplementation(async (_endpoint, body) => {
      const prompt = (body as { messages: Array<{ content: string }> }).messages.at(-1)!.content
      const content = prompt.includes('sum of the numbers')
        ? 'Certainly!\n```javascript\nfunction solve(values) { return values.reduce((a,b)=>a+b,0) }\n```\nThis returns the sum.'
        : '5,5'
      return new Response(JSON.stringify({ message: { content } }))
    })
    await service.courseStage(model, 'coding', 'practical')
    expect(runCases).toHaveBeenCalledWith('function solve(values) { return values.reduce((a,b)=>a+b,0) }', expect.any(Array), expect.any(AbortSignal))
    expect(latest()).toMatchObject({ score: 2 / 3 * 100, passed: false })
    expect(latest().checks.map(check => check.status)).toEqual(['failed', 'passed', 'passed'])
  })
  it('rejects stale attempts, passed exercises, other models/digests, and final-evaluation IDs', async () => {
    const { service, base, call } = await fixture()
    await expect(service.retryCourseExercise(model, 'coding', randomUUID(), 'coding-practical-1')).rejects.toThrow('latest practical')
    await expect(service.retryCourseExercise({ ...model, digest: 'version2' }, 'coding', base.id, 'coding-practical-1')).rejects.toThrow('model version')
    await expect(service.retryCourseExercise({ ...model, name: 'another:3b' }, 'coding', base.id, 'coding-practical-1')).rejects.toThrow('model version')
    await expect(service.retryCourseExercise(model, 'coding', base.id, 'coding-practical-sum')).rejects.toThrow('failed exercise')
    await expect(service.retryCourseExercise(model, 'coding', base.id, 'coding-evaluation-1')).rejects.toThrow('failed exercise')
    expect(call).not.toHaveBeenCalled()
  })
  it('keeps final evaluation independent after a successful retry', async () => {
    const { service, base, call, runCases, latest } = await fixture()
    await service.retryCourseExercise(model, 'coding', base.id, 'coding-practical-1')
    await service.courseStage(model, 'coding', 'ready')
    call.mockClear()
    call.mockImplementation(async (_endpoint, body) => {
      const prompt = (body as { messages: Array<{ content: string }> }).messages.at(-1)!.content
      const answer = prompt.includes('iterations') ? '5' : prompt.includes('filter') ? '8' : prompt.includes('UNVERIFIED') ? 'UNVERIFIED' : 'function solve(values) { return values.length ? Math.max(...values) : null }'
      return new Response(JSON.stringify({ message: { content: answer } }))
    })
    await service.courseStage(model, 'coding', 'evaluation')
    expect(call).toHaveBeenCalledTimes(4)
    expect((call.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages).toHaveLength(2)
    expect((call.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages[0].content).toContain('the body executes end - start times')
    expect((call.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages[0].content).toContain('i = 2; i < 7; i++')
    expect((call.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages.at(-1)!.content).toContain('for values 1,2,3')
    expect(runCases.mock.calls[0][1].map(test => test.name)).toEqual(['negative values', 'empty input', 'duplicates'])
    expect(latest()).toMatchObject({ stage: 'evaluation', attemptKind: 'full', score: 100, passed: true })
    expect(latest().checks.every(check => check.sourceResultId === latest().id)).toBe(true)
    expect(latest().checks.some(check => check.exerciseId?.includes('practical'))).toBe(false)
    await expect(service.retryCourseExercise(model, 'coding', latest().id, 'coding-evaluation-1')).rejects.toThrow('latest practical')
  })
  it('persists inference and sandbox failures with actionable details instead of fabricating a pass', async () => {
    const { service, base, call, runCases, latest } = await fixture()
    call.mockRejectedValueOnce(new Error('Ollama unavailable'))
    await service.retryCourseExercise(model, 'coding', base.id, 'coding-practical-1')
    expect(latest().checks[0]).toMatchObject({ passed: false, response: '', execution: { error: 'Ollama unavailable' } })
    call.mockImplementation(async () => new Response(JSON.stringify({ message: { content: 'function solve(values) { while(true) {} }' } })))
    runCases.mockRejectedValueOnce(new Error('Practice execution exceeded its 3-second limit.'))
    await service.courseStage(model, 'coding', 'practical')
    expect(latest().checks.slice(1).every(check => !check.passed && check.execution?.error?.includes('3-second'))).toBe(true)
  })
  it('cancels retries without saving fake completion and releases the local execution slot', async () => {
    const { service, base, call, latest } = await fixture()
    call.mockImplementation((_endpoint, _body, signal) => new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })))
    const pending = service.retryCourseExercise(model, 'coding', base.id, 'coding-practical-1')
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    await expect(service.retryCourseExercise(model, 'coding', base.id, 'coding-practical-1')).rejects.toThrow('Another local lesson')
    service.cancelEvaluation()
    await expect(pending).rejects.toThrow()
    expect(latest().id).toBe(base.id)
    call.mockImplementation(async () => new Response(JSON.stringify({ message: { content: '2,5' } })))
    await service.retryCourseExercise(model, 'coding', base.id, 'coding-practical-1')
    expect(latest().passed).toBe(true)
  })
  it('requires a typed retry command and refuses threshold changes on retries', async () => {
    const command = { action: 'retry-course-exercise', model: model.name, courseId: 'coding', resultId: randomUUID(), exerciseId: 'coding-practical-1' }
    expect(academyCommandSchema.safeParse(command).success).toBe(true)
    expect(academyCommandSchema.safeParse({ ...command, threshold: 50 }).success).toBe(false)
    const { directory, original } = await fixture()
    expect(JSON.parse(await readFile(join(directory, 'academy.json'), 'utf8')).courses[0].threshold).toBe(original.courses[0].threshold)
  })
})
