import { z } from 'zod'

export const mediaOperations = [
  'image',
  'edit-image',
  'gif',
  'video',
  'animate',
  'edit-video',
  'extend-video',
] as const
export type MediaOperation = (typeof mediaOperations)[number]
export const isVideoOperation = (operation: MediaOperation) =>
  ['video', 'animate', 'edit-video', 'extend-video'].includes(operation)
export const routingModes = ['auto', 'selected', 'preferred', 'no-charges', 'local', 'manual'] as const
export const mediaOptionsSchema = z
  .object({
    quality: z.enum(['auto', 'low', 'medium', 'high']).optional(),
    size: z.enum(['auto', '1024x1024', '1536x1024', '1024x1536']).optional(),
    transparent: z.boolean().optional(),
    format: z.enum(['png', 'jpeg', 'webp']).optional(),
    duration: z.number().int().min(1).max(15).optional(),
    aspect: z.enum(['16:9', '9:16', '1:1']).optional(),
    resolution: z.enum(['480p', '720p', '1080p']).optional(),
    audio: z.boolean().optional(),
    count: z.number().int().min(1).max(4).optional(),
  })
  .default({})
const routeSettings = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(routingModes).default('auto'),
  preferred: z.string().max(400).default(''),
  defaults: mediaOptionsSchema,
  previews: z.boolean().default(true),
  priority: z.array(z.string().max(400)).max(50).default([]),
})
export const mediaSettingsSchema = z.object({
  image: routeSettings.default(() => routeSettings.parse({})),
  video: routeSettings.default(() => routeSettings.parse({})),
  fallback: z.boolean().default(true),
  confirmPaid: z.boolean().default(true),
  paidRoutes: z.array(z.string().max(400)).max(50).default([]),
  monthlyRequests: z.number().int().min(0).max(10000).default(30),
  maxCostUSD: z.number().positive().max(10000).nullable().default(null),
  monthlyCostUSD: z.number().positive().max(100000).nullable().default(null),
  localEnabled: z.boolean().default(true),
  comfyPort: z.number().int().min(1024).max(65535).default(8188),
  workflows: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        operation: z.enum(mediaOperations),
        graph: z.string().min(2).max(100000),
        minimumMemoryGB: z.number().positive().max(1024),
      }),
    )
    .max(12)
    .default([]),
  custom: z
    .array(
      z.object({
        connection: z.string().uuid(),
        model: z.string().trim().min(1).max(160),
        protocol: z.enum(['images', 'xai-video']),
      }),
    )
    .max(20)
    .default([]),
})
export type MediaSettings = z.infer<typeof mediaSettingsSchema>
export const mediaDefaults = () => mediaSettingsSchema.parse({})
export const mediaJobSchema = z.object({
  requestId: z.string().uuid(),
  operation: z.enum(mediaOperations),
  prompt: z.string().min(1).max(12000),
  parentId: z.string().uuid().optional(),
  status: z.enum(['routing', 'approval', 'submitting', 'processing', 'ready', 'failed', 'stopped']),
  route: z.string().max(400).optional(),
  model: z.string().max(200).optional(),
  billing: z.enum(['local', 'api', 'subscription', 'free']).optional(),
  provider: z.string().max(120).optional(),
  canCancel: z.boolean().optional(),
  remoteId: z.string().max(600).optional(),
  selected: z.string().max(400),
  attempted: z.array(z.string().max(400)).max(50).default([]),
  started: z.number(),
  updated: z.number(),
  options: mediaOptionsSchema,
  estimatedUSD: z.number().nonnegative().optional(),
  usage: z
    .object({
      input_tokens: z.number().nonnegative().optional(),
      output_tokens: z.number().nonnegative().optional(),
      total_tokens: z.number().nonnegative().optional(),
    })
    .optional(),
  revisedPrompt: z.string().max(12000).optional(),
  actualCostUSD: z.number().nonnegative().optional(),
})
export type MediaJob = z.infer<typeof mediaJobSchema>
export type MediaOptions = MediaJob['options']
export interface MediaCapability {
  id: string
  provider: string
  model: string
  billing: NonNullable<MediaJob['billing']>
  operations: MediaOperation[]
  values?: Partial<Record<keyof MediaOptions, (string | number | boolean)[]>>
  connection: string
  controls: (keyof MediaOptions)[]
  native?: boolean
  included?: boolean
}
export interface MediaCatalog {
  selected?: string
  offline?: boolean
  routes: MediaCapability[]
  notices: string[]
  paidRequests: number
  accounts?: { provider: string; state: string; details: string }[]
  history?: { id: string; date: number; provider: string; status: string }[]
}
export const mediaCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('catalog'),
    includedOnly: z.boolean().optional(),
    sessionId: z.string().uuid().optional(),
  }),
  z.object({
    action: z.literal('compose'),
    sessionId: z.string().uuid(),
    mode: z.enum(['image', 'video']).nullable(),
    parentId: z.string().uuid().optional(),
    operation: z.enum(mediaOperations).optional(),
  }),
  z.object({ action: z.literal('import'), sessionId: z.string().uuid() }),
  z.object({
    action: z.literal('video-metadata'),
    sessionId: z.string().uuid(),
    id: z.string().uuid(),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
    duration: z.number().positive().max(86400).optional(),
    jpeg: z
      .instanceof(Uint8Array)
      .refine((b) => b.length <= 256 * 1024)
      .optional(),
  }),
  z.object({
    action: z.literal('frame'),
    sessionId: z.string().uuid(),
    parentId: z.string().uuid(),
    bytes: z.instanceof(Uint8Array).refine((b) => b.length <= 16 * 1024 * 1024),
  }),
  z.object({
    action: z.literal('remove-asset'),
    sessionId: z.string().uuid(),
    id: z.string().uuid(),
  }),
  z.object({
    action: z.enum(['approve', 'stop', 'track', 'cancel-provider']),
    sessionId: z.string().uuid(),
    messageId: z.string().uuid(),
    route: z.string().max(400).optional(),
  }),
  z.object({
    action: z.literal('generate'),
    sessionId: z.string().uuid(),
    requestId: z.string().uuid(),
    prompt: z.string().trim().min(1).max(12000),
    operation: z.enum(mediaOperations),
    parentId: z.string().uuid().optional(),
    options: mediaJobSchema.shape.options,
  }),
])
export type MediaCommand = z.infer<typeof mediaCommandSchema>

export function mediaIntent(text: string, previous?: 'image' | 'video'): MediaOperation | undefined {
  const request = text
    .trim()
    .replace(/^(?:hey\s+)?athena[, ]+|^please\s+/i, '')
    .replace(/^(?:can|could|would) you\s+(?:please\s+)?/i, '')
  if (
    !/^(?:generate|create|draw|paint|render|illustrate|animate|edit|turn|convert|make|add|remove|replace|extend|regenerate|vary|lengthen)\b/i.test(
      request,
    )
  )
    return
  if (
    /\b(?:prompt|code|script|tutorial|instructions|algorithm|function|example code|explanation|component|endpoint|player|component|uploader|library|implementation|image generator|video generator)\b/i.test(
      request.split(/\b(?:showing|depicting|of a|of an)\b/i)[0],
    )
  )
    return
  if (/\b(?:animated\s+)?gif\b/i.test(request)) return 'gif'
  if (
    /^extend\b|^lengthen\b|^make\b.*\b(?:longer|extended)\b/i.test(request) &&
    (previous === 'video' || /\bvideo\b/i.test(request))
  )
    return 'extend-video'
  if (/^animate\b/i.test(request)) return 'animate'
  if (/\b(?:video|clip|movie|film)\b/i.test(request))
    return previous === 'image' && /\b(?:this|that|edited|previous|the image|this forest|it)\b/i.test(request)
      ? 'animate'
      : previous === 'video' && /^(?:edit|add|make this|remove|replace)/i.test(request)
        ? 'edit-video'
        : 'video'
  if (
    /\b(?:repository|typescript|endpoint|tests?|function|database|migration|dependency|src\/|unit test|class method|documentation)\b/i.test(
      request,
    )
  )
    return
  if (/^(?:edit|add|remove|replace|vary)\b|^make (?:it|this|a variation)\b/i.test(request))
    return previous === 'image' ? 'edit-image' : previous === 'video' ? 'edit-video' : undefined
  if (
    /^(?:draw|paint|illustrate)\b|\b(?:image|picture|photo|photograph|illustration|portrait|painting|poster|wallpaper|photorealistic|snowy (?:green )?forest|cinematic landscape)\b/i.test(
      request,
    )
  )
    return 'image'
}
export function mediaRoutes(
  routes: MediaCapability[],
  job: Pick<MediaJob, 'operation' | 'attempted' | 'options' | 'selected'>,
  settings: MediaSettings,
  offline: boolean,
) {
  const prefs = isVideoOperation(job.operation) ? settings.video : settings.image
  if (!prefs.enabled) return []
  if (!settings.fallback && prefs.preferred && ['auto', 'preferred', 'manual'].includes(prefs.mode))
    routes = routes.filter((r) => r.id === prefs.preferred)
  const candidates = routes.filter(
    (r) =>
      r.operations.includes(job.operation) &&
      !job.attempted.includes(r.id) &&
      Object.entries(job.options).every(([name, value]) => {
        const k = name as keyof MediaOptions
        return r.controls.includes(k) && (!r.values?.[k] || r.values[k]!.includes(value))
      }) &&
      (!(offline || prefs.mode === 'local') || r.billing === 'local') &&
      (prefs.mode !== 'no-charges' ||
        r.billing === 'local' ||
        r.billing === 'free' ||
        (r.billing === 'subscription' && r.included === true)) &&
      (prefs.mode !== 'manual' || r.id === prefs.preferred),
  )
  const rank = (r: MediaCapability) => {
    const selected = r.connection === job.selected && r.native
    if (prefs.mode === 'selected' && selected) return -4
    if (r.id === prefs.preferred) return -3
    if (selected) return -2
    const index = prefs.priority.indexOf(r.id)
    return index >= 0 ? index : 100 + (r.billing === 'local' ? 1 : 0)
  }
  return candidates.sort((a, b) => rank(a) - rank(b))
}
