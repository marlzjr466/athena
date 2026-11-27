import { z } from 'zod'

export const LIVE_MODEL = 'gpt-live-1.1'
export const ACTIVE_USD_PER_MIN = 0.05
export const BUILTIN_VOICES = ['marin','alloy','ash','ballad','beacon','bossa','cedar','cinder','coral','delta','echo','gleam','meridian','quartz','ripple','sage','shimmer','stone','tempo','verse','vesper','willow'] as const
export const YOUTHFUL_DESCRIPTION = 'An original fictional young adult feminine voice, approximately 18–20 years old, with a naturally bright, soft, sweet, and youthful vocal tone. Use a medium-high pitch, smooth vocal texture, gentle resonance, and lively melodic intonation. Sound cheerful, energetic, playful, curious, and approachable. Speak naturally with expressive emotions, spontaneous laughter where appropriate, gentle breaths, and realistic conversational timing. Maintain clear pronunciation in English, Filipino, and Taglish. Avoid robotic delivery, exaggerated squeaking, artificial pitch shifting, and overly formal speech. Sound like a friendly, expressive young adult anime-inspired AI assistant while maintaining realistic human conversational qualities.'
export const sampleLines = {
  English: "Hi! I'm Athena. What would you like to work on today?",
  Filipino: 'Kumusta! Ako si Athena. Ano ang gusto mong gawin ngayon?',
  Taglish: 'Hi! Ready na ako. Ano ang first project natin today?',
}
const voiceId = z.string().regex(/^voice_[A-Za-z0-9_-]{1,180}$/)
export const acousticTraits = ['Pitch','Brightness','Softness','Warmth','Expressiveness','Playfulness','Speaking pace'] as const
const trait = z.number().int().min(1).max(5)
export const designSchema = z.object({
  name: z.string().trim().min(1).max(80), description:z.string().trim().min(20).max(2200),
  profile:z.enum(['Athena Youthful','Calm guide','Custom adult voice']),
  traits:z.array(trait).length(acousticTraits.length),
})
export type VoiceDesign = z.infer<typeof designSchema>
export const initialDesign:VoiceDesign = {name:'Athena Youthful',description:YOUTHFUL_DESCRIPTION,profile:'Athena Youthful',traits:[4,4,4,4,4,4,3]}
export function designPrompt(design:VoiceDesign) {
  const levels = ['very low','low','moderate','high','very high']
  return [design.description, acousticTraits.map((name,i)=>name+' '+levels[design.traits[i]-1]).join(', ')+'.'].join('\n')
}
export const savedVoiceSchema = z.object({ id:voiceId, name:z.string().min(1).max(80), prompt:z.string().max(4000), account:z.string().min(1), createdAt:z.number(), design:designSchema })
export const liveVoiceSchema = z.object({
  engine:z.enum(['live','local']).default('live'), cloudAllowed:z.boolean().default(false), fallback:z.boolean().default(true),
  fullDuplex:z.boolean().default(true), voice:z.union([z.enum(BUILTIN_VOICES),voiceId]).default('marin'),
  chosen:z.boolean().default(false), voices:z.array(savedVoiceSchema).max(100).default([]),
  design:designSchema.default(initialDesign),
  personality:z.string().max(3000).default('You are Athena, a cheerful, warm adult assistant. Match the user’s English, Filipino, or Taglish. Speak briefly and naturally, leave space for interruptions, and use laughter or fillers sparingly.'),
  idleSeconds:z.number().int().min(5).max(600).default(60), maxSeconds:z.number().int().min(15).max(3600).default(600),
  historyDays:z.union([z.literal(0),z.literal(1),z.literal(7),z.literal(30)]).default(7),
  monthlyUSD:z.number().finite().min(0).max(10000).default(80),
})
export const liveVoiceDefaults = liveVoiceSchema.parse({})
export type LiveVoiceSettings = z.infer<typeof liveVoiceSchema>
const request = z.string().uuid()
export const voiceEntrySchema=z.object({
  id:z.string().max(150),role:z.enum(['user','assistant','task']),text:z.string().min(1).max(5000),
  offset:z.number().nonnegative().finite(), partial:z.boolean().optional(),
}).strict()
export type VoiceEntry=z.infer<typeof voiceEntrySchema>
export interface VoiceMemoryView {
  id:string; conversations:{id:string;updated:number}[]; recent:VoiceEntry[]; summary:string[];
  notes:{id:string;text:string}[]; compacted:number; persistent:boolean
}
export const liveCommandSchema = z.discriminatedUnion('action',[
  z.object({action:z.literal('checkpoint'),request,entries:z.array(voiceEntrySchema).max(64)}),
  z.object({action:z.literal('memory'),operation:z.enum(['inspect','new','select','clear','save-note','remove-note','edit-note']),id:z.string().uuid().optional(),text:z.string().trim().min(1).max(400).optional()}),
  z.object({action:z.literal('status')}),z.object({action:z.literal('check')}),
  z.object({action:z.literal('generate'), design:designSchema, regenerate:z.boolean().optional()}),
  z.object({action:z.literal('start'), request, sdp:z.string().startsWith('v=0').max(64000), mode:z.enum(['floating','preview','test']), language:z.enum(['English','Filipino','Taglish']).default('English'),initial:z.string().max(3000).optional(),voice:voiceId.optional()}),
  z.object({action:z.literal('usage'), request, seconds:z.number().nonnegative().finite().max(86400)}),
  z.object({action:z.literal('stop'), request, finalSeconds:z.number().nonnegative().finite().max(86400).optional()}),
  z.object({action:z.literal('billing')}),
])
export type LiveCommand = z.input<typeof liveCommandSchema>
export interface LiveReply {
  conversationId?:string; memory?:VoiceMemoryView; endConversation?:boolean; restoredItems?:number; credential?:boolean; message?:string; sdp?:string; sessionId?:string; expiresAt?:number
  saved?:z.infer<typeof savedVoiceSchema>; uncertain?:number; daily?:number; monthly?:number; seconds?:number; reported?:number; cost?:number; threshold?:number; active?:boolean
}
