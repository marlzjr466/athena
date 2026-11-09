import { z } from 'zod'
import { localModelIdSchema } from './localAI'

export const interviewModeSchema = z.enum(['quick', 'detailed', 'technical', 'practice'])
export type InterviewMode = z.infer<typeof interviewModeSchema>
const citedPointSchema = z.object({ text: z.string().trim().min(1).max(500), quote: z.string().trim().min(1).max(500) }).strict()
export const meetingNoteSchema = z.object({
  id: z.string().uuid(), model: localModelIdSchema, createdAt: z.string().datetime(),
  transcript: z.string().min(1).max(12_000), summary: z.string().trim().min(1).max(3000),
  decisions: z.array(citedPointSchema).max(12), actionItems: z.array(citedPointSchema.extend({ owner: z.string().trim().max(100).optional() })).max(12),
}).strict()
export type MeetingNote = z.infer<typeof meetingNoteSchema>
export const interviewPracticeSchema = z.object({
  id: z.string().uuid(), model: localModelIdSchema, createdAt: z.string().datetime(),
  mode: interviewModeSchema, topic: z.string().trim().min(1).max(120), question: z.string().trim().min(1).max(1500),
  answer: z.string().trim().min(1).max(6000).optional(), feedback: z.string().trim().min(1).max(3000).optional(),
}).strict()
export type InterviewPractice = z.infer<typeof interviewPracticeSchema>
export const codingChallengeIds = ['sum-pairs', 'palindrome', 'binary-search'] as const
export const codingChallengeIdSchema = z.enum(codingChallengeIds)
export type CodingChallengeId = z.infer<typeof codingChallengeIdSchema>
export const codingChallengeDescriptions: Record<CodingChallengeId, { title: string; prompt: string; starter: string; hints: string[] }> = {
  'sum-pairs': { title: 'Sum even numbers', prompt: 'Implement solve(numbers): return the sum of even integers in the array. Do not mutate the input.', starter: 'function solve(numbers) {\n  // Your code here\n}', hints: ['Consider filtering by remainder.', 'An accumulator can sum the matching values.'] },
  palindrome: { title: 'Normalized palindrome', prompt: 'Implement solve(text): return whether the text reads the same backward, ignoring case and non-alphanumeric characters.', starter: 'function solve(text) {\n  // Your code here\n}', hints: ['Normalize before comparing.', 'Compare normalized text with its reverse.'] },
  'binary-search': { title: 'Binary search', prompt: 'Implement solve(sortedNumbers, target): return the index of target, or -1 if absent. Input is sorted ascending.', starter: 'function solve(sortedNumbers, target) {\n  // Your code here\n}', hints: ['Keep lower and upper bounds.', 'Discard half of the remaining range each step.'] },
}
export const codingAttemptSchema = z.object({
  id: z.string().uuid(), model: localModelIdSchema, challenge: codingChallengeIdSchema,
  createdAt: z.string().datetime(), passed: z.number().int().nonnegative(), total: z.number().int().positive(),
  results: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string().max(400) })).max(20),
}).strict()
export type CodingAttempt = z.infer<typeof codingAttemptSchema>
export interface AcademyStudioSnapshot { meetings: MeetingNote[]; interviews: InterviewPractice[]; attempts: CodingAttempt[] }
export interface AcademyStudioResult { ok: boolean; snapshot: AcademyStudioSnapshot; message?: string; transcript?: string }
export const academyStudioCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare-meeting'), model: localModelIdSchema, transcript: z.string().trim().min(20).max(12_000) }).strict(),
  z.object({ action: z.literal('start-interview'), model: localModelIdSchema, mode: interviewModeSchema, topic: z.string().trim().min(1).max(120) }).strict(),
  z.object({ action: z.literal('answer-interview'), id: z.string().uuid(), answer: z.string().trim().min(1).max(6000) }).strict(),
  z.object({ action: z.literal('delete-meeting'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('export-meeting'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('delete-interview'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('run-coding-practice'), model: localModelIdSchema, challenge: codingChallengeIdSchema, code: z.string().min(1).max(12_000) }).strict(),
  z.object({ action: z.literal('delete-coding-attempt'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('import-meeting-audio'), model: localModelIdSchema }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
])
export type AcademyStudioCommand = z.infer<typeof academyStudioCommandSchema>
