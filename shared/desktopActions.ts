import { z } from 'zod'

export const APPLICATIONS = {
  vscode: { name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode' },
  chrome: { name: 'Google Chrome', bundleId: 'com.google.Chrome' },
  safari: { name: 'Safari', bundleId: 'com.apple.Safari' },
  finder: { name: 'Finder', bundleId: 'com.apple.finder' },
  terminal: { name: 'Terminal', bundleId: 'com.apple.Terminal' },
  slack: { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' },
  spotify: { name: 'Spotify', bundleId: 'com.spotify.client' },
  notes: { name: 'Notes', bundleId: 'com.apple.Notes' },
  cursor: {name:'Cursor',bundleId:'com.todesktop.230313mzl4w4u92'},
  edge: {name:'Microsoft Edge',bundleId:'com.microsoft.edgemac'},
  firefox: {name:'Firefox',bundleId:'org.mozilla.firefox'},
  teams: {name:'Microsoft Teams',bundleId:'com.microsoft.teams2'},
  word: {name:'Microsoft Word',bundleId:'com.microsoft.Word'},
  excel: {name:'Microsoft Excel',bundleId:'com.microsoft.Excel'},
  discord: {name:'Discord',bundleId:'com.hnc.Discord'},
  calculator: { name: 'Calculator', bundleId: 'com.apple.calculator' },
} as const
export const appIdentifierSchema = z.enum(Object.keys(APPLICATIONS) as [keyof typeof APPLICATIONS,...Array<keyof typeof APPLICATIONS>])
export type AppIdentifier = z.infer<typeof appIdentifierSchema>

export const webURLSchema = z.string().min(1).max(2048).transform((value, context) => {
  try {
    if (/\s|[\u0000-\u001f\u007f]|\\/.test(value) || !/^https?:\/\//i.test(value)) throw new Error()
    const url = new URL(value)
    if (!url.hostname || url.username || url.password) throw new Error()
    return url.href
  } catch {
    context.addIssue({ code: 'custom', message: 'Use an http:// or https:// URL without credentials, whitespace, or control characters.' })
    return z.NEVER
  }
})
export const applicationActionSchema = z.object({ app: appIdentifierSchema }).strict()
export const urlActionSchema = z.object({ url: webURLSchema }).strict()
export const notificationActionSchema = z.object({
  title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(400),
}).strict()

export interface DesktopActionResult {
  ok: boolean
  status: 'completed' | 'submitted' | 'failed' | 'denied' | 'cancelled'
  message: string
}

export const accessibilityTargetSchema = z.object({ app: appIdentifierSchema }).strict()
export const accessibilityLabelSchema = accessibilityTargetSchema.extend({ label: z.string().trim().min(1).max(160) }).strict()
export const accessibleTextSchema = accessibilityLabelSchema.extend({ text: z.string().max(2000) }).strict()
export const accessibilityShortcutSchema = accessibilityTargetSchema.extend({ shortcut: z.enum(['copy', 'paste', 'select-all', 'save', 'undo', 'redo', 'enter', 'escape', 'tab']) }).strict()
export const windowOperationSchema = z.enum(['minimize','maximize','restore','move','close'])
export type WindowOperation = z.infer<typeof windowOperationSchema>
export const windowActionSchema = accessibilityTargetSchema.extend({operation:windowOperationSchema,x:z.number().int().min(-32768).max(32767).optional(),y:z.number().int().min(-32768).max(32767).optional()}).strict().refine(v=>v.operation!=='move'||(v.x!==undefined&&v.y!==undefined))
export const accessibilityScrollSchema = accessibilityTargetSchema.extend({ label: z.string().trim().min(1).max(160), direction: z.enum(['up', 'down']) }).strict()

export const visualPointSchema=z.object({x:z.number().int().nonnegative().max(8192),y:z.number().int().nonnegative().max(8192)}).strict()
export const visualGestureSchema=z.object({captureId:z.string().uuid(),app:appIdentifierSchema,label:z.string().trim().min(1).max(100),from:visualPointSchema,to:visualPointSchema.optional()}).strict()
export type VisualGesture=z.infer<typeof visualGestureSchema>
export const desktopRectSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive() })
export type DesktopRect = z.infer<typeof desktopRectSchema>
export interface AccessibleElement { focused?:boolean; searchField?:boolean; bounds?: DesktopRect; label: string; role: string; enabled: boolean; value?: string }
export interface AccessibilityInspection { app: string; window: string; elements: AccessibleElement[]; windowToken?: string }
export interface AccessibilityActionResult { ok: boolean; verified: boolean; message: string }
