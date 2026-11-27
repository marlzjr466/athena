import { z } from 'zod'
import { webURLSchema } from './desktopActions'

export const voiceBrowserActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('window'), operation: z.enum(['new-tab','new-window','current','navigate','other-display']), browser: z.enum(['chrome','edge','safari','firefox']).optional(), url: webURLSchema.optional() }).strict(),
  z.object({ action: z.literal('open'), url: webURLSchema }).strict(),
  z.object({ action: z.enum(['tabs', 'inspect', 'read', 'back', 'forward', 'first-video','close-tab','other-tab','click-observed']) }).strict(),
  z.object({ action:z.literal('video-result'), index:z.number().int().min(1).max(50) }).strict(),
  z.object({ action: z.literal('select'), query: z.string().trim().min(1).max(160) }).strict(),
  z.object({ action: z.literal('media'), operation: z.enum(['play', 'pause', 'seek', 'volume', 'fullscreen', 'exit-fullscreen']), value: z.number().finite().min(-120).max(120).optional() }).strict(),
  z.object({ action:z.literal('choose'),label:z.string().trim().min(1).max(160),option:z.string().trim().min(1).max(160) }).strict(),
  z.object({action:z.enum(['upload','download']),label:z.string().trim().min(1).max(160)}).strict(),
  z.object({ action: z.literal('click'), label: z.string().trim().min(1).max(160) }).strict(),
  z.object({ action: z.literal('type'), label: z.string().trim().min(1).max(160), text: z.string().max(2000) }).strict(),
  z.object({ action: z.literal('submit-search'), label: z.string().trim().min(1).max(160), text: z.string().min(1).max(2000).regex(/^[^\u0000-\u001f\u007f]+$/u) }).strict(),
  z.object({ action: z.literal('scroll'), direction: z.enum(['up', 'down']) }).strict(),
])
export type VoiceBrowserAction = z.infer<typeof voiceBrowserActionSchema>
