import { z } from 'zod'
import { VROID_ACTION_IDS } from './vroidActions'

export const importedAvatarId = z.string().regex(/^imported-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
export const avatarIdSchema = z.union([z.enum(['classic', 'enhanced', 'vroid-athena']), importedAvatarId])
export const isVrmAvatar = (id: string | undefined) => id === 'vroid-athena' || Boolean(id?.startsWith('imported-'))
export const MODEL_NAME_LIMIT = 60
export const modelNameSchema = z.string().trim().min(1, 'Enter a model name.').max(MODEL_NAME_LIMIT, 'Use at most 60 characters.').refine(name => !/[\p{Cc}\p{Cf}]/u.test(name), 'Control characters are not allowed in model names.')
export const IMPORT_STAGES = ['Importing VRM file', 'Validating model', 'Loading geometry and textures', 'Initializing humanoid skeleton', 'Loading existing VRMA animation library', 'Binding compatible animations', 'Preparing the default Idle animation', 'Generating avatar thumbnail', 'Finalizing model registration', 'Ready to use'] as const
export const clipReportSchema = z.object({ id: z.enum(VROID_ACTION_IDS), duration: z.number().finite().positive().max(600).optional(), error: z.string().max(500).optional() }).strict()
export const avatarRecordSchema = z.object({
  id: importedAvatarId, name: modelNameSchema, sourceFileName: z.string().max(255),
  modelPath: z.string(), thumbnailPath: z.string().optional(), thumbnail: z.string().optional(), thumbnailVersion: z.number().int().optional(),
  importStatus: z.enum(['processing', 'ready', 'error']), stage: z.enum(IMPORT_STAGES),
  compatibleAnimations: z.array(clipReportSchema).max(VROID_ACTION_IDS.length),
  enabledActions: z.array(z.enum(VROID_ACTION_IDS)).max(VROID_ACTION_IDS.length),
  animationSettings: z.object({ random: z.boolean(), idleMs: z.literal(3000) }),
  scale: z.number().positive(), configuration: z.object({ version: z.string().optional() }),
  importError: z.string().optional(),
})
export type ImportedAvatar = z.infer<typeof avatarRecordSchema>
export interface ModelPick { token: string; fileName: string; suggestedName: string }
export type ModelCommand =
  | { action: 'pick' }
  | { action: 'import'; token: string; name: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'delete'; id: string }
  | { action: 'thumbnail'; id: string; thumbnail: string }
  | { action: 'retry'; id: string }
  | { action: 'progress'; id: string; stage: typeof IMPORT_STAGES[number] }
  | { action: 'fail'; id: string; error: string }
  | { action: 'finish'; id: string; thumbnail: string; clips: ImportedAvatar['compatibleAnimations']; scale: number }
  | { action: 'preferences'; id: string; enabledActions: ImportedAvatar['enabledActions']; random: boolean }
export interface ModelResult { ok: boolean; error?: string; pick?: ModelPick; model?: ImportedAvatar }
export const BUNDLED_NAMES: Record<string, string> = { classic: 'Athena Classic', enhanced: 'Athena Enhanced', 'vroid-athena': 'Athena' }
export function avatarName(id: string, models: readonly ImportedAvatar[] = []) { return models.find(model => model.id === id)?.name ?? BUNDLED_NAMES[id] ?? 'Unavailable model' }
export function validateModelName(input: string, models: readonly Pick<ImportedAvatar, 'id' | 'name'>[], excludeId?: string): string {
  const parsed = modelNameSchema.safeParse(input)
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)
  const key = parsed.data.normalize('NFKC').toLocaleLowerCase()
  if ([...Object.values(BUNDLED_NAMES), ...models.filter(m => m.id !== excludeId).map(m => m.name)].some(n => n.normalize('NFKC').toLocaleLowerCase() === key)) throw new Error('A model already uses this name. Choose a different name.')
  return parsed.data
}
