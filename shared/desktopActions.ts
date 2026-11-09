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
  calculator: { name: 'Calculator', bundleId: 'com.apple.calculator' },
} as const
export const appIdentifierSchema = z.enum(['vscode', 'chrome', 'safari', 'finder', 'terminal', 'slack', 'spotify', 'notes', 'calculator'])
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
export const accessibilityScrollSchema = accessibilityTargetSchema.extend({ label: z.string().trim().min(1).max(160), direction: z.enum(['up', 'down']) }).strict()

export interface AccessibleElement { label: string; role: string; enabled: boolean; value?: string }
export interface AccessibilityInspection { app: string; window: string; elements: AccessibleElement[] }
export interface AccessibilityActionResult { ok: boolean; verified: boolean; message: string }
