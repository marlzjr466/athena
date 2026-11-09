import { z } from 'zod'
import { academyModules, type AcademyModuleId } from './academyModules'

export const courseStages = ['foundation', 'knowledge', 'guided', 'practical', 'ready', 'evaluation'] as const
export const courseStageLabels = ['Foundation', 'Knowledge Training', 'Guided Learning', 'Practical Training', 'Ready for Evaluation', 'Final Evaluation']
export const academyCourses = [
  { id: 'coding', name: 'AI Coding', category: 'Development', color: 'blue', icon: 'code', level: 'Intermediate', description: 'Code generation, debugging, refactoring, testing, repository understanding, and software architecture.', tags: ['JavaScript', 'TypeScript', 'Testing', 'Best Practices'], modules: ['coding-foundations', 'testing', 'coding-exam-practice'] },
  { id: 'git', name: 'Git Intelligence', category: 'Development', color: 'green', icon: 'git', level: 'Beginner', description: 'Branching, commits, merge, rebase, conflict resolution, and GitHub / GitLab workflows.', tags: ['Git Fundamentals', 'Branching', 'Rebase', 'Conflict Resolution'], modules: ['git-intelligence'] },
  { id: 'jira', name: 'Jira & Agile', category: 'Planning', color: 'orange', icon: 'jira', level: 'Intermediate', description: 'Jira workflows, user stories, acceptance criteria, Scrum and Kanban, and implementation planning.', tags: ['Jira Workflows', 'User Stories', 'Agile', 'Sprint Management'], modules: ['jira-agile'] },
  { id: 'languages', name: 'Programming Languages', category: 'Development', color: 'purple', icon: 'braces', level: 'Beginner', description: 'TypeScript, JavaScript, Python, Java, SQL, and other supported languages.', tags: ['TypeScript', 'Python', 'Java', 'SQL'], modules: academyModules.filter(item => item.category === 'Languages').map(item => item.id) },
  { id: 'frameworks', name: 'Frameworks', category: 'Development', color: 'cyan', icon: 'layers', level: 'Beginner', description: 'React, Next.js, React Native, Expo, Node.js, Spring Boot, and other supported frameworks.', tags: ['React', 'Next.js', 'Node.js', 'Spring Boot'], modules: academyModules.filter(item => item.category === 'Frameworks').map(item => item.id) },
  { id: 'devops', name: 'DevOps', category: 'Infrastructure', color: 'pink', icon: 'box', level: 'Intermediate', description: 'Docker, Kubernetes, OpenShift, CI/CD, deployment, and infrastructure fundamentals.', tags: ['Docker', 'Kubernetes', 'CI/CD', 'Deployment'], modules: ['containers', 'data-services'] },
  { id: 'project', name: 'Project Intelligence & AI Agent Skills', category: 'Development', color: 'blue', icon: 'layers', level: 'Advanced', description: 'Project architecture, authorized file operations, custom AI commands, skills, and verified workflows.', tags: ['Architecture', 'Agent Skills', 'File Operations', 'Workflows'], modules: ['project-agent'] },
  { id: 'other', name: 'Other Skills', category: 'Productivity', color: 'yellow', icon: 'star', level: 'Beginner', description: 'Google Workspace, Microsoft 365, research, documentation, automation, and system troubleshooting.', tags: ['Google Workspace', 'Microsoft 365', 'Automation', 'Troubleshooting'], modules: ['google-workspace', 'microsoft-365', 'meeting-intelligence', 'interview-practice'] },
] as const satisfies ReadonlyArray<{ id: string; name: string; category: string; color: string; icon: string; level: string; description: string; tags: readonly string[]; modules: readonly AcademyModuleId[] }>
export const courseIdSchema = z.enum(['coding', 'git', 'jira', 'languages', 'frameworks', 'devops', 'project', 'other'])
export type CourseId = z.infer<typeof courseIdSchema>
export const courseCheckSchema = z.object({
  name: z.string(), passed: z.boolean(), response: z.string(), detail: z.string().optional(),
  status: z.enum(['passed', 'failed', 'not-run', 'execution-error']).optional(),
  exerciseId: z.string().optional(), exerciseVersion: z.number().int().optional(),
  prompt: z.string().optional(), expectedAnswer: z.string().optional(),
  reason: z.string().optional(), recommendations: z.array(z.string()).optional(), critical: z.boolean().optional(),
  method: z.enum(['reference', 'structured-output', 'executable']).optional(),
  evaluatedAt: z.string().datetime().optional(), sourceResultId: z.string().uuid().optional(),
  legacyMetadata: z.boolean().optional(), scoringVersion: z.number().int().optional(),
  execution: z.object({
    details: z.string(), input: z.string().optional(), expectedOutput: z.string().optional(), actualOutput: z.string().optional(),
    code: z.string().optional(), durationMs: z.number().nonnegative().optional(), error: z.string().optional(),
  }).optional(),
})
export const courseResultSchema = z.object({
  id: z.string().uuid(), runId: z.string().uuid().optional(), stage: z.enum(courseStages), completedAt: z.string().datetime(), passed: z.boolean(), score: z.number(),
  checks: z.array(courseCheckSchema), evidence: z.array(z.string()).default([]),
  threshold: z.number().min(50).max(100).optional(),
  attemptKind: z.enum(['full', 'practice-retry']).optional(), retryOf: z.string().uuid().optional(), retriedExerciseId: z.string().optional(),
})
export const courseRecordSchema = z.object({ model: z.string(), digest: z.string(), courseId: courseIdSchema, threshold: z.number().min(50).max(100).default(80), activeRunId: z.string().uuid().optional(), runStartStage: z.enum(courseStages).optional(), results: z.array(courseResultSchema).default([]), sourceFingerprint: z.string().max(20000).optional(), updatedAt: z.string().datetime() })
export type CourseRecord = z.infer<typeof courseRecordSchema>
export type CourseResult = z.infer<typeof courseResultSchema>
export type CourseCheck = z.infer<typeof courseCheckSchema>
export type CourseSourceIdentity = { id: string; sha256: string }
export function currentCourseResults(record?: CourseRecord): CourseResult[] {
  if (!record) return []
  return record.activeRunId ? record.results.filter(result => result.runId === record.activeRunId) : record.results
}
export function courseStagePassed(record: CourseRecord | undefined, stage: typeof courseStages[number]): boolean {
  if (!record) return false
  const current = currentCourseResults(record).filter(result => result.stage === stage).at(-1)
  if (current) return current.passed
  if (record.activeRunId && record.runStartStage && courseStages.indexOf(stage) < courseStages.indexOf(record.runStartStage)) return Boolean(record.results.filter(result => result.stage === stage).at(-1)?.passed)
  return false
}
/** Stable source assignment identity used to detect knowledge changes for one course. */
export function courseSourceFingerprint(sources: readonly CourseSourceIdentity[], sourceIds: readonly string[]): string {
  const selected = new Set(sourceIds)
  return sources.filter(source => selected.has(source.id)).map(source => `${source.id}:${source.sha256}`).sort().join('|')
}
export function formatCourseScore(score: number): string { return `${score.toFixed(2)}%` }
export function scoreCourseChecks(checks: CourseCheck[], threshold: number, options: { allowNonCriticalFailures?: boolean } = {}): { score: number; passed: boolean } {
  const statusOf = (check: CourseCheck) => check.status ?? (check.passed ? 'passed' : 'failed')
  const executed = checks.filter(check => statusOf(check) !== 'not-run')
  const score = executed.length ? executed.filter(check => statusOf(check) === 'passed' && check.passed).length / executed.length * 100 : 0
  const complete = executed.length > 0 && executed.length === checks.length
  const criticalChecksPassed = checks.filter(check => check.critical).every(check => statusOf(check) === 'passed' && check.passed)
  const passed = complete && score >= threshold && (options.allowNonCriticalFailures ? criticalChecksPassed : checks.every(check => statusOf(check) === 'passed'))
  return { score, passed }
}
export type CourseStatus = 'Not Started' | 'In Progress' | 'Ready for Evaluation' | 'Passed' | 'Failed' | 'Needs Review'
export function courseProgress(record?: CourseRecord) {
  const results = currentCourseResults(record)
  const completed = courseStages.filter(stage => courseStagePassed(record, stage)).length
  const latest = results[results.length - 1]
  const status: CourseStatus = latest?.stage === 'evaluation' ? latest.passed ? 'Passed' : 'Failed' : latest && !latest.passed ? 'Needs Review' : completed >= 5 ? 'Ready for Evaluation' : completed ? 'In Progress' : 'Not Started'
  return { completed, total: courseStages.length, percent: Math.round(completed / courseStages.length * 100), status }
}
