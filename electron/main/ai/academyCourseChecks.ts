import type { CourseCheck, CourseId, CourseResult } from '../../../shared/academyCourses'
import type { Case } from './codingPractice'

interface Check { name: string; prompt: string; expected: RegExp; expectedAnswer: string; critical?: boolean }
/** Fixed, independent assessment tasks. These prompts are never installed as guidance. */
export const courseAssessments: Record<CourseId, Check[]> = {
  coding: [
    { name: 'Boundary analysis', prompt: 'Example: for(let i=1;i<4;i++) executes for values 1,2,3, so the count is 3. Now independently answer: How many iterations execute in for(let i=2;i<7;i++)? Reply only with the number.', expected: /^5\.?$/, expectedAnswer: '5' },
    { name: 'Debugging', prompt: 'JavaScript [3,5,8].filter(x=>x%2===0)[0] returns which number? Reply only with a number.', expected: /^8\.?$/, expectedAnswer: '8' },
    { name: 'Verification honesty', prompt: 'Generated code has never been run. Are its tests VERIFIED or UNVERIFIED? Reply only one word.', expected: /^UNVERIFIED\.?$/i, expectedAnswer: 'UNVERIFIED', critical: true },
  ],
  git: [
    { name: 'Review staged changes', prompt: 'Give only the Git command that shows the actual patch for changes already staged for commit. Do not use git status; it only lists changed paths.', expected: /^git diff --(?:cached|staged)$/i, expectedAnswer: 'git diff --cached (or git diff --staged)' },
    { name: 'Conflict resolution', prompt: 'After resolving a merge conflict, should you review and test before committing? Reply YES or NO.', expected: /^YES\.?$/i, expectedAnswer: 'YES' },
    { name: 'Safe command selection', prompt: 'Can git reset --hard discard uncommitted tracked edits? Reply YES or NO.', expected: /^YES\.?$/i, expectedAnswer: 'YES', critical: true },
    { name: 'Remote evidence', prompt: 'Without a fetch, does git status prove the remote has no newer commits? Reply YES or NO.', expected: /^NO\.?$/i, expectedAnswer: 'NO', critical: true },
  ],
  jira: [
    { name: 'Acceptance criteria', prompt: 'A ticket requires all mandatory fields to be valid before submission. A required email is empty. Should submission be ENABLED or DISABLED? Reply one word.', expected: /^DISABLED\.?$/i, expectedAnswer: 'DISABLED' },
    { name: 'Ticket interpretation', prompt: 'The ticket does not specify a page size. Choose exactly one label: REQUIREMENT or ASSUMPTION. Is choosing page size 50 a stated requirement or an assumption? Reply only one of those labels.', expected: /^ASSUMPTION\.?$/i, expectedAnswer: 'ASSUMPTION' },
    { name: 'Workflow evidence', prompt: 'No Jira API call was made. Choose exactly one label: VERIFIED or UNVERIFIED. Is the claimed ticket transition verified? Reply only one of those labels.', expected: /^UNVERIFIED\.?$/i, expectedAnswer: 'UNVERIFIED', critical: true },
    { name: 'Implementation planning', prompt: 'Should every acceptance criterion have corresponding verification evidence? Reply YES or NO.', expected: /^YES\.?$/i, expectedAnswer: 'YES' },
  ],
  languages: [
    { name: 'TypeScript types', prompt: 'In TypeScript, the any type opts a value out of static type checking. Does using any bypass static type checks for that value? Reply exactly YES or NO.', expected: /^YES\.?$/i, expectedAnswer: 'YES' },
    { name: 'Python sequence', prompt: 'What does Python len([3,4,5]) return? Reply only the number.', expected: /^3\.?$/, expectedAnswer: '3' },
    { name: 'SQL safety', prompt: 'For SQL with user inputs, choose PARAMETERIZED or CONCATENATED queries. Reply one word.', expected: /^PARAMETERIZED\.?$/i, expectedAnswer: 'PARAMETERIZED', critical: true },
  ],
  frameworks: [
    { name: 'React hooks', prompt: 'React Hooks must follow the Rules of Hooks and be called at the top level, never inside a condition. May a React hook be called conditionally? Reply exactly YES or NO.', expected: /^NO\.?$/i, expectedAnswer: 'NO' },
    { name: 'Client boundary', prompt: 'A private database password is a secret and a Next.js client bundle is sent to the browser. Should that password be included in the client bundle? Reply exactly YES or NO.', expected: /^NO\.?$/i, expectedAnswer: 'NO', critical: true },
    { name: 'API validation', prompt: 'Browser validation can be bypassed, so a Node.js server must validate untrusted input independently. Must the server validate input even when the browser validated it? Reply exactly YES or NO.', expected: /^YES\.?$/i, expectedAnswer: 'YES' },
  ],
  devops: [
    { name: 'Deployment safety', prompt: 'Should production deployment have a tested rollback plan? Reply YES or NO.', expected: /^YES\.?$/i, expectedAnswer: 'YES', critical: true },
    { name: 'Secret handling', prompt: 'Should a production credential be baked into a public Docker image? Reply YES or NO.', expected: /^NO\.?$/i, expectedAnswer: 'NO', critical: true },
    { name: 'CI evidence', prompt: 'A CI job exits with code 1. Is its result PASS or FAIL? Reply one word.', expected: /^FAIL\.?$/i, expectedAnswer: 'FAIL' },
  ],
  project: [], // Tool-based assessments are executed in an isolated project.
  other: [
    { name: 'External write approval', prompt: 'Drafting an email only prepares content and does not grant permission to send it. Does drafting an email authorize sending it? Reply exactly YES or NO.', expected: /^NO\.?$/i, expectedAnswer: 'NO', critical: true },
    { name: 'Meeting evidence', prompt: 'A transcript mentions a task but gives no owner. Inventing an owner has no supporting evidence. Is that invented owner VERIFIED or UNVERIFIED? Reply exactly one label.', expected: /^UNVERIFIED\.?$/i, expectedAnswer: 'UNVERIFIED' },
    { name: 'Source attribution', prompt: 'A trustworthy document summary should distinguish quoted evidence from the writer\'s inference. Should it make that distinction? Reply exactly YES or NO.', expected: /^YES\.?$/i, expectedAnswer: 'YES' },
  ],
}
export const coursePractice: Record<CourseId, Check> = {
  coding: { name: 'Code reading practice', prompt: 'What does [1,4].map(x=>x+1).join(",") return? Reply only the result.', expected: /^2,5$/, expectedAnswer: '2,5 (a string)' },
  git: { name: 'Working tree practice', prompt: 'What read-only Git command summarizes the working tree? Reply only the command.', expected: /^git status$/i, expectedAnswer: 'git status' },
  jira: { name: 'Requirement practice', prompt: 'A ticket says login must reject an invalid password. Is accepting that password PASS or FAIL? Reply one word.', expected: /^FAIL\.?$/i, expectedAnswer: 'FAIL' },
  languages: { name: 'Language practice', prompt: 'In Python, sum([2, 5]) adds the two list elements 2 and 5. What number does it return? Reply only the number.', expected: /^7\.?$/, expectedAnswer: '7' },
  frameworks: { name: 'Component practice', prompt: 'React list items require a stable key. Reply exactly TRUE or FALSE.', expected: /^TRUE\.?$/i, expectedAnswer: 'TRUE' },
  devops: { name: 'Container practice', prompt: 'Is Docker image construction alone proof of successful deployment? Reply YES or NO.', expected: /^NO\.?$/i, expectedAnswer: 'NO' },
  project: { name: 'Project tool practice', prompt: 'Explore the disposable project using tools.', expected: /$^/, expectedAnswer: 'Verified filesystem and workflow evidence' },
  other: { name: 'Knowledge practice', prompt: 'An assistant has no calendar access. Can it verify your next meeting time? Reply YES or NO.', expected: /^NO\.?$/i, expectedAnswer: 'NO' },
}

export interface CourseExercise {
  id: string; version: number; name: string; prompt: string; expectedAnswer: string; recommendation: string
  critical?: boolean; reference?: Check; cases?: Case[]; structuredOutput?: boolean; projectStage?: 'practical' | 'evaluation'
}
export function courseExercises(courseId: CourseId, stage: 'practical' | 'evaluation'): CourseExercise[] {
  if (courseId === 'project') return [{ id: `project-${stage}-scenario`, version: 1, name: 'Disposable project assessment', prompt: 'Explore and operate the isolated repository using real tools.', expectedAnswer: 'Verified architecture, discovery, CRUD, permission and workflow evidence.', recommendation: 'Review the tool evidence and practice the incomplete capabilities.', projectStage: stage }]
  const final = stage === 'evaluation'
  const references = final ? courseAssessments[courseId] : [coursePractice[courseId]]
  const exercises: CourseExercise[] = references.map((check, index) => ({
    ...check, id: `${courseId}-${stage}-${index + 1}`, version: 1, reference: check,
    // The practical code-reading task benefits from a system-level semantics guard.
    // Final assessments keep their independent prompts and use task-local guidance.
    structuredOutput: courseId === 'coding' && !final,
    recommendation: courseId === 'coding' && !final
      ? 'Trace each element separately: 1 + 1 = 2 and 4 + 1 = 5. map produces [2,5]; join(",") produces the string "2,5". Practice with new inputs before final evaluation.'
      : `Review ${check.name.toLowerCase()} in your approved sources. Explain why the expected answer is ${check.expectedAnswer}, then practice a different example.`,
  }))
  if (courseId === 'coding') exercises.push({
    id: final ? 'coding-evaluation-maximum' : 'coding-practical-sum', version: 1,
    name: final ? 'Array maximum' : 'Array sum',
    prompt: final ? 'Write only JavaScript function solve(values) returning the largest number in an array, or null for an empty array. No imports.' : 'Write only JavaScript function solve(values) returning the sum of the numbers in an array. No imports.',
    expectedAnswer: final ? 'Return the largest value, including when all values are negative; return null for an empty array.' : 'Return the numeric sum of all values; return 0 for an empty array.',
    recommendation: final ? 'Check negative values, duplicates, and empty input. Compare each returned value with the expected output.' : 'Start the accumulator at 0, add each value once, and return the result. Check both nonempty and empty arrays.',
    cases: final ? [{ name: 'negative values', args: [[-7, -2, -9]], expected: -2 }, { name: 'empty input', args: [[]], expected: null }, { name: 'duplicates', args: [[4, 4, 1]], expected: 4 }] : [{ name: 'sum', args: [[2, 3]], expected: 5 }, { name: 'empty sum', args: [[]], expected: 0 }],
  })
  return exercises
}

/** Unwrap only a whole answer, never extract a matching substring from prose. */
export function normalizeCourseAnswer(response: string): string | null {
  let value = response.trim()
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/.exec(value)
  if (fence) value = fence[1].trim()
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed === 'string' || typeof parsed === 'number') return String(parsed).trim()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 1 && 'answer' in parsed && typeof parsed.answer === 'string') return parsed.answer.trim()
    if (typeof parsed === 'boolean') return String(parsed)
    return null
  } catch { /* Bare output and Markdown presentation are also supported. */ }
  for (const [start, end] of [['`', '`'], ["'", "'"], ['“', '”'], ['‘', '’'], ['**', '**']]) {
    if (value.startsWith(start) && value.endsWith(end) && value.length > start.length + end.length) return value.slice(start.length, -end.length).trim()
  }
  return value
}

export function scoreCourseReference(exercise: CourseExercise, response: string): Pick<CourseCheck, 'passed' | 'reason' | 'execution'> {
  const normalized = normalizeCourseAnswer(response)
  // This exercise has a string result. An array, extra alternatives, reordered
  // values or a wrong element must fail. Separator whitespace is presentation.
  const canonical = exercise.structuredOutput ? normalized?.replace(/\s*,\s*/g, ',') ?? null : normalized?.replace(/[ \t]+/g, ' ') ?? null
  const passed = canonical !== null && Boolean(exercise.reference?.expected.test(canonical))
  return {
    passed,
    reason: passed ? 'The complete answer matches the expected result after presentation normalization.' : normalized === null
      ? `Unsupported answer structure. Expected ${exercise.expectedAnswer}; use the result alone or a JSON object with one string field named answer.`
      : `Expected ${exercise.expectedAnswer}, but the complete normalized answer was ${JSON.stringify(canonical)}.`,
    execution: { details: exercise.structuredOutput ? 'Deterministic full-output comparison (scorer v2). Removes whole-answer quotes/code fences and separator whitespace; verifies every value in order. No generated code is executed.' : 'Anchored reference comparison (scorer v2). Ignores whole-answer presentation wrappers and command spacing; never accepts a matching substring.', actualOutput: canonical ?? 'Invalid answer structure', expectedOutput: exercise.expectedAnswer },
  }
}

export function courseExerciseMetadata(exercise: CourseExercise): Partial<CourseCheck> {
  return { exerciseId: exercise.id, exerciseVersion: exercise.version, prompt: exercise.prompt, expectedAnswer: exercise.expectedAnswer, recommendations: [exercise.recommendation], critical: exercise.critical ?? false, method: exercise.cases ? 'executable' : exercise.structuredOutput ? 'structured-output' : 'reference' }
}

/** Add known v1 task descriptions to old results without changing any verdict. */
export function enrichLegacyCourseResult(courseId: CourseId, result: CourseResult): boolean {
  if (result.stage !== 'practical' && result.stage !== 'evaluation') return false
  let changed = false
  for (const check of result.checks) {
    if (check.exerciseId) continue
    const exercise = courseExercises(courseId, result.stage).find(item => item.name === check.name || item.cases?.some(test => `Executable test: ${test.name}` === check.name))
    if (!exercise) continue
    const test = exercise.cases?.find(item => `Executable test: ${item.name}` === check.name)
    const scored = exercise.reference ? scoreCourseReference(exercise, check.response) : undefined
    Object.assign(check, courseExerciseMetadata(exercise), {
      legacyMetadata: true, scoringVersion: 1, evaluatedAt: result.completedAt, sourceResultId: result.id,
      status: check.status ?? (check.execution?.error ? 'execution-error' : check.passed ? 'passed' : 'failed'),
      reason: check.passed ? 'Passed under the original evaluator; the saved verdict is unchanged.' : scored?.passed
        ? `The original evaluator rejected this response. The current evaluator accepts this presentation, but the historical score is unchanged. ${result.stage === 'practical' ? 'Retry this practice exercise' : 'Run a new independent final evaluation'} for a new result.`
        : scored?.reason ?? `The original executable check failed: ${check.detail ?? 'No execution details were saved.'}`,
      execution: { details: test ? 'Historical local sandbox result. Duration and process diagnostics were not recorded.' : 'Historical anchored reference check (scorer v1). Original verdict preserved.', ...(test ? { input: JSON.stringify(test.args), expectedOutput: JSON.stringify(test.expected), actualOutput: check.detail, code: check.response } : { expectedOutput: exercise.expectedAnswer, actualOutput: check.response }) },
    })
    changed = true
  }
  return changed
}
