import { z } from 'zod'

export const appInfoSchema = z.object({
  name: z.string().trim().min(1).max(200),
  bundleId: z.string().trim().max(300).nullable(),
  pid: z.number().int().positive(),
}).strict()
export type AppInfo = z.infer<typeof appInfoSchema>

export const applicationSnapshotSchema = z.object({
  active: appInfoSchema.nullable(),
  running: z.array(appInfoSchema).max(300),
}).strict()
export type ApplicationSnapshot = z.infer<typeof applicationSnapshotSchema>

export type ApplicationDetectionResult =
  | { ok: true; active: AppInfo | null; running: AppInfo[] }
  | { ok: false; message: string }
