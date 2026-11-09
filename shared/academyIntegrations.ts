import { z } from 'zod'

export const academyCodeHostSchema = z.enum(['github', 'gitlab'])
export type AcademyCodeHost = z.infer<typeof academyCodeHostSchema>
export const academyRepositorySchema = z.string().min(3).max(200).regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/, 'Use a repository path such as owner/project.').refine(value => value.split('/').every(segment => segment !== '.' && segment !== '..'), 'Repository path traversal is not allowed.')
export const academyIntegrationCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect'), provider: academyCodeHostSchema, token: z.string().trim().min(8).max(500) }).strict(),
  z.object({ action: z.literal('disconnect'), provider: academyCodeHostSchema }).strict(),
  z.object({ action: z.literal('inspect-review'), provider: academyCodeHostSchema, repository: academyRepositorySchema, number: z.number().int().positive().max(1_000_000_000) }).strict(),
])
export type AcademyIntegrationCommand = z.infer<typeof academyIntegrationCommandSchema>
export interface AcademyIntegrationStatus { provider: AcademyCodeHost; connected: boolean; account?: string; verifiedAt?: string; error?: string }
export interface AcademyReviewEvidence { provider: AcademyCodeHost; repository: string; number: number; title: string; state: string; author: string; updatedAt: string; url: string; description: string; pipelineStatus?: string }
export interface AcademyIntegrationResult { ok: boolean; statuses: AcademyIntegrationStatus[]; review?: AcademyReviewEvidence; message?: string }
