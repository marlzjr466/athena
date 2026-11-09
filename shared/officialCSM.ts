import { z } from 'zod'

export const officialCSMSettingsSchema = z.object({
  device: z.enum(['cpu', 'mps', 'cuda']).default('cpu'),
  speaker: z.number().int().min(0).max(1).default(0),
  referenceId: z.string().uuid().optional(),
  context: z.boolean().default(true),
}).strict()
// A private copy of Athena's verified US-English reference sample. This is an
// audio context anchor, not a CSM speaker preset or a second TTS engine.
// Changing this ID intentionally invalidates any old cached anchor so a
// previously conditioned accent cannot survive an update.
export const ATHENA_CSM_REFERENCE_ID = 'b4b34c95-7b6f-4ea9-b2f8-17cc9d3b3cf4'
export const officialCSMCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('setup') }).strict(),
  z.object({ action: z.literal('download') }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('unload') }).strict(),
  z.object({ action: z.literal('import-reference'), transcript: z.string().trim().min(1).max(1200), speaker: z.number().int().min(0).max(1), authorized: z.literal(true) }).strict(),
  z.object({ action: z.literal('remove-reference'), id: z.string().uuid() }).strict(),
])
export type OfficialCSMCommand = z.infer<typeof officialCSMCommandSchema>
export interface CSMReference { id: string; name: string; transcript: string; speaker: number; seconds: number }
export interface CSMStatus {
  runtime: boolean; downloaded: boolean; loaded: boolean; busy: boolean
  stage: string; error?: string; device?: string
  automaticReferenceAvailable?: boolean
  references: CSMReference[]
  metrics?: { loadMs: number; generationMs: number; totalMs: number; audioSeconds: number; peakProcessBytes: number; device: string; contextSegments: number }
}
export interface CSMResult { ok: boolean; message?: string; status?: CSMStatus; referenceId?: string }
