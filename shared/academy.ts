import { z } from 'zod'
import { localModelIdSchema } from './localAI'
import { courseIdSchema, courseStages, type CourseRecord } from './academyCourses'
import { academyModules, type AcademyModuleId } from './academyModules'
export { academyModules } from './academyModules'
export const academyModuleIdSchema = z.enum(academyModules.map(module => module.id) as [AcademyModuleId, ...AcademyModuleId[]])
export type { AcademyModuleId } from './academyModules'
export const academyModelSchema = localModelIdSchema
export const academyInstructionsSchema = z.string().trim().max(4000)
export const academyProfileSchema = z.object({
  model: academyModelSchema,
  digest: z.string().max(200).optional(),
  family: z.string().max(200).optional(),
  quantization: z.string().max(100).optional(),
  instructions: academyInstructionsSchema.default(''),
  modules: z.array(z.object({ id: academyModuleIdSchema, enabled: z.boolean() }).strict()).max(academyModules.length).default([]),
  /** Source assignments are scoped to an Academy course. `personal-knowledge` is retained for pre-course API compatibility. */
  knowledgeAssignments: z.array(z.object({ courseId: z.union([courseIdSchema, academyModuleIdSchema]), sourceIds: z.array(z.string().uuid()).max(200) }).strict()).max(academyModules.length + 10).default([]),
  /** Legacy links are retained for migration and old clients; new UI uses knowledgeAssignments. */
  knowledgeIds: z.array(z.string().uuid()).max(200).default([]),
  unassignedKnowledgeIds: z.array(z.string().uuid()).max(200).default([]),
  knowledgeReview: z.string().max(500).optional(),
  embeddingModel: localModelIdSchema.nullable().default(null),
  embeddingDigest: z.string().max(200).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastEvaluatedAt: z.string().datetime().optional(),
  learnFromCorrections: z.boolean().default(false),
}).strict()
type AcademyProfileParsed = z.infer<typeof academyProfileSchema>
/** Accepts snapshots written by pre-module Academy clients while parsed data
 * from the schema still receives empty arrays for the new fields. */
export type AcademyProfile = Omit<AcademyProfileParsed, 'knowledgeAssignments' | 'unassignedKnowledgeIds' | 'knowledgeReview'> & {
  knowledgeAssignments?: AcademyProfileParsed['knowledgeAssignments']
  unassignedKnowledgeIds?: AcademyProfileParsed['unassignedKnowledgeIds']
  knowledgeReview?: AcademyProfileParsed['knowledgeReview']
}
export const academyCorrectionKindSchema = z.enum(['code', 'convention', 'explanation', 'format', 'workflow'])
export const academyCorrectionSchema = z.object({
  id: z.string().uuid(), model: academyModelSchema, digest: z.string().max(200), kind: academyCorrectionKindSchema,
  prompt: z.string().trim().min(4).max(1200), correction: z.string().trim().min(4).max(2400),
  evidence: z.string().trim().min(4).max(1200), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict()
export type AcademyCorrection = z.infer<typeof academyCorrectionSchema>
export const academyKnowledgeScopeSchema = z.union([courseIdSchema, academyModuleIdSchema])
export type AcademyKnowledgeScope = z.infer<typeof academyKnowledgeScopeSchema>
export const academyIndexSchema = z.object({
  /** The embedding model name. Kept as `model` for compatibility with existing Academy data. */
  model: localModelIdSchema,
  /** Digest of the embedding model. */
  digest: z.string().max(200).optional(),
  /** Scope of the index. Missing values are legacy, pre-module indexes. */
  courseId: z.string().max(100).optional(),
  localModel: academyModelSchema.optional(),
  localDigest: z.string().max(200).optional(),
  status: z.enum(['indexing', 'paused', 'ready', 'failed']),
  indexedChunks: z.number().int().nonnegative(), totalChunks: z.number().int().nonnegative(), updatedAt: z.string().datetime(), error: z.string().max(300).optional(),
}).strict()
export const academySourceSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(255), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), addedAt: z.string().datetime(), indexes: z.array(academyIndexSchema).max(20).default([]) }).strict()
export type AcademySource = z.infer<typeof academySourceSchema>
export const academyEvaluationTrackSchema = z.enum(['general', 'coding', 'git', 'jira'])
export type AcademyEvaluationTrack = z.infer<typeof academyEvaluationTrackSchema>
export const academyEvaluationSchema = z.object({ id: z.string().uuid(), model: academyModelSchema, digest: z.string().max(200).optional(), track: academyEvaluationTrackSchema.default('general'), createdAt: z.string().datetime(), completedAt: z.string().datetime(), passed: z.number().int().nonnegative(), total: z.number().int().positive(), checks: z.array(z.object({ name: z.string(), passed: z.boolean(), response: z.string().max(240) }).strict()) }).strict()
export type AcademyEvaluation = z.infer<typeof academyEvaluationSchema>
export interface AcademySnapshot { profiles: AcademyProfile[]; sources: AcademySource[]; evaluations: AcademyEvaluation[]; corrections?: AcademyCorrection[]; courses?: CourseRecord[] }
/** Compare only identical prompt tracks against each model's currently verified digest. */
export function academyComparison(snapshot: AcademySnapshot, track: AcademyEvaluationTrack) {
  return snapshot.profiles.map(profile => {
    const history = profile.digest ? snapshot.evaluations.filter(item => item.model === profile.model && item.digest === profile.digest && item.track === track).sort((a, b) => b.completedAt.localeCompare(a.completedAt)) : []
    return { model: profile.model, digest: profile.digest, latest: history[0], previous: history[1] }
  })
}
export interface AcademyIndexProgress { sourceId: string; model: string; courseId?: AcademyKnowledgeScope; indexedChunks: number; totalChunks: number; status: 'indexing' | 'paused' | 'ready' | 'failed'; message?: string }
export interface AcademyResult { ok: boolean; snapshot: AcademySnapshot; message?: string }
export const academyCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('course-stage'), model: academyModelSchema, courseId: courseIdSchema, stage: z.enum(courseStages), threshold: z.number().min(50).max(100).default(80) }).strict(),
  z.object({ action: z.literal('restart-course'), model: academyModelSchema, courseId: courseIdSchema }).strict(),
  z.object({ action: z.literal('delete-course-result'), model: academyModelSchema, courseId: courseIdSchema, resultId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('retry-course-exercise'), model: academyModelSchema, courseId: courseIdSchema, resultId: z.string().uuid(), exerciseId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal('profile'), model: academyModelSchema }).strict(),
  z.object({ action: z.literal('instructions'), model: academyModelSchema, instructions: academyInstructionsSchema }).strict(),
  z.object({ action: z.literal('module'), model: academyModelSchema, id: academyModuleIdSchema, installed: z.boolean(), enabled: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('link-source'), model: academyModelSchema, sourceId: z.string().uuid(), linked: z.boolean(), courseId: academyKnowledgeScopeSchema.optional() }).strict(),
  z.object({ action: z.literal('embedding-model'), model: academyModelSchema, embeddingModel: localModelIdSchema.nullable() }).strict(),
  z.object({ action: z.literal('index-source'), model: academyModelSchema, sourceId: z.string().uuid(), courseId: academyKnowledgeScopeSchema.optional() }).strict(),
  z.object({ action: z.literal('cancel-index') }).strict(),
  z.object({ action: z.literal('add-source'), model: academyModelSchema, courseId: academyKnowledgeScopeSchema.optional() }).strict(),
  z.object({ action: z.literal('remove-source'), sourceId: z.string().uuid(), model: academyModelSchema.optional(), courseId: academyKnowledgeScopeSchema.optional() }).strict(),
  z.object({ action: z.literal('evaluate'), model: academyModelSchema, track: academyEvaluationTrackSchema.optional() }).strict(),
  z.object({ action: z.literal('cancel-evaluation') }).strict(),
  z.object({ action: z.literal('learning-toggle'), model: academyModelSchema, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('save-correction'), model: academyModelSchema, kind: academyCorrectionKindSchema, prompt: academyCorrectionSchema.shape.prompt, correction: academyCorrectionSchema.shape.correction, evidence: academyCorrectionSchema.shape.evidence }).strict(),
  z.object({ action: z.literal('update-correction'), model: academyModelSchema, id: z.string().uuid(), kind: academyCorrectionKindSchema, prompt: academyCorrectionSchema.shape.prompt, correction: academyCorrectionSchema.shape.correction, evidence: academyCorrectionSchema.shape.evidence }).strict(),
  z.object({ action: z.literal('remove-correction'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('export-corrections'), model: academyModelSchema }).strict(),
])
export type AcademyCommand = z.infer<typeof academyCommandSchema>

export interface AcademyProjectProgress { model: string; digest: string; stage: 'guided' | 'practical' | 'evaluation'; round: number; tool: string; status: 'running' | 'complete' | 'failed'; summary: string }
