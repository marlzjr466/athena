import { z } from 'zod'
import type { Attachment } from './conversations'
import type { MeetingNote } from './meetingNotes'
export const MEETING_COMMAND = 'athena:meeting-command'
export const MEETING_EVENT = 'athena:meeting-event'
export const sourceSchema = z.enum(['microphone', 'system'])
export type MeetingSource = z.infer<typeof sourceSchema>
export const meetingPreferencesSchema = z.object({
  provider: z.enum(['local', 'subscription', 'cloud', 'claude-api']).default('local'),
  model: z.string().max(200).default('qwen2.5-coder:3b'),
  cloudConsent: z.boolean().default(false), aiConsent: z.boolean().default(false),
  microphone: z.boolean().default(false), system: z.boolean().default(false),
  deviceId: z.string().max(500).default('default'), systemSource: z.string().max(500).default(''),
  partialTranscripts: z.boolean().default(false), retainAudio: z.boolean().default(false), screenConsent: z.boolean().default(false),
  retainScreens: z.boolean().default(false), autoNotes: z.boolean().default(false),
  questions: z.enum(['off', 'suggest', 'request', 'automatic']).default('off'),
  style: z.enum(['quick', 'standard', 'detailed', 'coding']).default('standard'),
  template: z.enum(['general', 'technical', 'standup', 'interview']).default('general'),
  language: z.string().regex(/^(auto|[a-z]{2,3})$/).default('auto'),
  whisperBinary: z.string().max(1000).default(''), whisperModel: z.string().max(1000).default(''),
  alwaysOnTop: z.boolean().default(true), opacity: z.number().min(0.4).max(1).default(0.97),
  protection: z.boolean().default(false), compact: z.boolean().default(false),
}).strict()
export const meetingPreferencesPatchSchema = z.object({
  provider: meetingPreferencesSchema.shape.provider.removeDefault().optional(),
  model: meetingPreferencesSchema.shape.model.removeDefault().optional(),
  cloudConsent: meetingPreferencesSchema.shape.cloudConsent.removeDefault().optional(),
  aiConsent: meetingPreferencesSchema.shape.aiConsent.removeDefault().optional(),
  microphone: meetingPreferencesSchema.shape.microphone.removeDefault().optional(),
  system: meetingPreferencesSchema.shape.system.removeDefault().optional(),
  deviceId: meetingPreferencesSchema.shape.deviceId.removeDefault().optional(),
  systemSource: meetingPreferencesSchema.shape.systemSource.removeDefault().optional(),
  partialTranscripts: meetingPreferencesSchema.shape.partialTranscripts.removeDefault().optional(),
  retainAudio: meetingPreferencesSchema.shape.retainAudio.removeDefault().optional(),
  screenConsent: meetingPreferencesSchema.shape.screenConsent.removeDefault().optional(),
  retainScreens: meetingPreferencesSchema.shape.retainScreens.removeDefault().optional(),
  autoNotes: meetingPreferencesSchema.shape.autoNotes.removeDefault().optional(),
  questions: meetingPreferencesSchema.shape.questions.removeDefault().optional(),
  style: meetingPreferencesSchema.shape.style.removeDefault().optional(),
  template: meetingPreferencesSchema.shape.template.removeDefault().optional(),
  language: meetingPreferencesSchema.shape.language.removeDefault().optional(),
  whisperBinary: meetingPreferencesSchema.shape.whisperBinary.removeDefault().optional(),
  whisperModel: meetingPreferencesSchema.shape.whisperModel.removeDefault().optional(),
  alwaysOnTop: meetingPreferencesSchema.shape.alwaysOnTop.removeDefault().optional(),
  opacity: meetingPreferencesSchema.shape.opacity.removeDefault().optional(),
  protection: meetingPreferencesSchema.shape.protection.removeDefault().optional(),
  compact: meetingPreferencesSchema.shape.compact.removeDefault().optional(),
}).strict()
export type MeetingPreferences = z.infer<typeof meetingPreferencesSchema>
export interface MeetingSegment { id: string; source: MeetingSource; start: number; end: number; text: string; speaker: string; speakerOverride?: string; provisional?: boolean; status: 'pending' | 'complete' | 'error'; error?: string; audio?: string; latencyMs?: number }
export interface MeetingAnswer { id: string; question: string; text: string; model: string; provider: string; createdAt: number; status: 'streaming' | 'complete' | 'error' | 'stopped'; kind: 'answer' | 'notes' | 'screen'; screenContext?: { name: string; method: 'vision' | 'local-text'; capturedAt: number } }
export interface MeetingSession { id: string; title: string; createdAt: number; startedAt?: number; endedAt?: number; status: 'ready' | 'recording' | 'paused' | 'stopped' | 'interrupted'; preferences: MeetingPreferences; speakers: Record<MeetingSource, string>; draft: string; attachments?: Attachment[]; notes: string; noteItems?: MeetingNote[]; notedSegmentIds?: string[]; notesThrough?: string; segments: MeetingSegment[]; answers: MeetingAnswer[]; screenReferences: string[]; externalLink?: string }
export interface MeetingSnapshot { session?: MeetingSession; history: Array<{ id: string; title: string; createdAt: number; status: MeetingSession['status'] }>; platform: string; protection: string; error?: string; busy: boolean; safeMode: boolean; liveScreenActive?: boolean; liveScreenUntil?: number; screenCaptureAt?: number }
export const meetingCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }), z.object({ action: z.literal('create'), title: z.string().min(1).max(200), template: meetingPreferencesSchema.shape.template }),
  z.object({ action: z.literal('open'), id: z.string().uuid() }), z.object({ action: z.literal('delete'), id: z.string().uuid() }),
  z.object({ action: z.literal('preferences'), patch: meetingPreferencesPatchSchema }),
  z.object({ action: z.literal('rename'), title: z.string().min(1).max(200) }),
  z.object({ action: z.literal('draft'), sessionId: z.string().uuid(), text: z.string().max(100000) }),
  z.object({ action: z.literal('speaker'), source: sourceSchema, name: z.string().min(1).max(100) }),
  z.object({ action: z.literal('record'), state: z.enum(['start', 'pause', 'resume', 'stop']), consent: z.boolean().optional() }),
  z.object({ action: z.literal('audio'), partial: z.boolean().default(false), sessionId: z.string().uuid(), id: z.string().uuid(), source: sourceSchema, start: z.number().nonnegative(), end: z.number().nonnegative(), bytes: z.instanceof(Uint8Array).refine(b => b.length >= 44 && b.length <= 600000) }),
  z.object({ action: z.literal('capture-state'), sessionId: z.string().uuid(), captureId: z.string().uuid(), source: sourceSchema, active: z.boolean() }),
  z.object({ action: z.literal('retry'), id: z.string().uuid() }),
  z.object({ action: z.literal('ask'), text: z.string().min(1).max(100000), kind: z.enum(['answer', 'notes', 'screen']).default('answer'), sourceId: z.string().max(500).optional() }),
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('confirm-note'), index: z.number().int().min(0).max(20000), confirmed: z.boolean() }),
  z.object({ action: z.literal('panel'), mode: z.enum(['show', 'hide', 'minimize', 'safe', 'restore', 'expand']) }),
  z.object({ action: z.literal('sources') }), z.object({ action: z.literal('models') }),
  z.object({ action: z.literal('screen-access'), operation: z.enum(['check', 'request', 'settings', 'reveal', 'restart']) }),
  z.object({ action: z.literal('export'), format: z.enum(['md', 'txt', 'json', 'pdf', 'docx', 'audio']) }),
  z.object({ action: z.literal('delete-audio') }),
  z.object({ action: z.literal('delete-screens') }),
  z.object({ action: z.literal('attach-paste'), sessionId: z.string().uuid(), text: z.string().min(1).max(100000) }),
  z.object({ action: z.literal('attach-source') }),
  z.object({ action: z.literal('remove-attachment'), id: z.string().uuid() }),
  z.object({ action: z.literal('segment-speaker'), id: z.string().uuid(), name: z.string().min(1).max(100) }),
  z.object({ action: z.literal('live-screen'), sourceId: z.string().max(500).optional(), minutes: z.number().int().min(0).max(5).optional() }),
  z.object({ action: z.literal('source-error'), sessionId: z.string().uuid(), source: sourceSchema, message: z.string().max(500) }),
])
export type MeetingCommand = z.input<typeof meetingCommandSchema>
export interface MeetingScreenAccess { status: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown' | 'not-required'; appPath: string }
export interface MeetingResult { ok: boolean; message?: string; snapshot?: MeetingSnapshot; screenAccess?: MeetingScreenAccess; sources?: Array<{ id: string; name: string }>; models?: Array<{ id: string; provider: MeetingPreferences['provider']; vision: boolean }> }
export interface MeetingAPI { command(input: MeetingCommand): Promise<MeetingResult>; subscribe(listener: (snapshot: MeetingSnapshot) => void): () => void }
declare global { interface Window { meetings?: MeetingAPI } }
export function transcriptText(s: MeetingSession, segments = s.segments): string { return segments.map(v => `[${new Date(v.start).toISOString()}] ${v.speakerOverride || s.speakers[v.source] || v.speaker}: ${v.status === 'complete' ? v.text : `[${v.status}: ${v.error || 'transcribing'}]`}`).join('\n') }
export function meetingDocument(s: MeetingSession): string { return `# ${s.title}\n\n${new Date(s.createdAt).toLocaleString()}\nDuration: ${Math.max(0, Math.round(((s.endedAt || Date.now()) - (s.startedAt || Date.now())) / 60000))} minutes\n\n## AI notes — review against transcript\n${s.notes || 'No notes generated.'}\n\n## Transcript\n${transcriptText(s)}\n\n## Questions and answers\n${s.answers.filter(a => a.kind !== 'notes').map(a => `### ${a.question}\n${a.text}\n(${a.provider} / ${a.model}; ${a.status})`).join('\n\n')}` }
export function detectedQuestion(text: string): string | undefined { return text.match(/(?:^|[.!]\s+)([^.!]*\?)/)?.[1]?.trim() }
