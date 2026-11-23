import { z } from 'zod'

export const choiceInteractionSchema = z.object({
  id: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(180),
  messageId: z.string().min(1).max(180),
  type: z.literal('choice'),
  question: z.string().min(1).max(1200),
  mode: z.enum(['single', 'multiple']),
  options: z.array(z.string().min(1).max(1000)).min(2).max(8),
  freeTextOptions: z.array(z.string().max(1000)).max(8),
  allowOther: z.boolean(),
  status: z.enum(['pending', 'answered']).default('pending'),
  answerMessageId: z.string().max(180).optional(),
  answer: z.string().max(12_000).optional(),
}).strict()

export type ChoiceInteraction = z.infer<typeof choiceInteractionSchema>

export interface ParsedChoiceInteraction {
  interaction: ChoiceInteraction
  /** The non-choice portion of the response, suitable for rendering beside the form. */
  bodyContent: string
}

const choiceLine = /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+|[A-Z][.)]\s+)(.+?)\s*$/
const instructionLine = /\b(?:choose|select|pick)\s+(?:one|an option|a response|all|multiple|any|more than one)\b|\bselect all that apply\b/i
const interrogativeLine = /^\s*(?:which|what|where|when|who|whom|whose|how|is|are|am|was|were|do|does|did|can|could|should|would|will|have|has|had)\b[\s\S]*\?\s*$/i
const choiceQuestionLine = /^\s*(?:which|what|where|when|who|whom|whose|how)\b[\s\S]*\?\s*$/i

function optionText(value: string): string {
  return value.trim()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1$2')
    .trim()
}

/**
 * Compatibility parser for providers that return ordinary Markdown instead of
 * a structured choice interaction. It only accepts a final enumerated list
 * paired with an explicit choice instruction or an unambiguous question.
 */
export function parseChoiceInteraction(
  content: string,
  identity: { conversationId: string; messageId: string },
): ParsedChoiceInteraction | null {
  const lines = content.split(/\r?\n/)
  const inFence: boolean[] = []
  let fenced = false
  for (let line = 0; line < lines.length; line++) {
    if (/^\s{0,3}(?:```|~~~)/.test(lines[line])) fenced = !fenced
    inFence[line] = fenced
  }

  const options: string[] = []
  const optionIndexes: number[] = []
  let index = lines.length - 1
  while (index >= 0 && !lines[index].trim()) index--
  for (; index >= 0;) {
    if (inFence[index]) break
    const match = choiceLine.exec(lines[index])
    if (match) {
      const option = optionText(match[1])
      if (!option || option.length > 1000 || /^\[[ xX]\]/.test(option)) return null
      options.unshift(option)
      optionIndexes.unshift(index)
      index--
      if (options.length > 8) return null
      continue
    }
    if (!lines[index].trim() && options.length && index > 0) { index--; continue }
    break
  }
  if (options.length < 2) return null

  const firstOptionIndex = optionIndexes[0]
  const contextStart = Math.max(0, firstOptionIndex - 8)
  const prefix = lines.slice(contextStart, firstOptionIndex)
  const instructionOffset = prefix.findLastIndex((line) => instructionLine.test(line.trim()))
  const instructionIndex = instructionOffset >= 0 ? contextStart + instructionOffset : -1
  const questionIndex = prefix.findLastIndex((line) => interrogativeLine.test(line.trim()))
  const questionLineIndex = questionIndex >= 0 ? contextStart + questionIndex : -1
  const explicitlyDirected = instructionIndex >= 0
  const yesNoOptions = options.length === 2 && /^(?:yes|yeah|yep)\b/i.test(options[0]) && /^(?:no|nope)\b/i.test(options[1])
  const hasClearQuestion = questionLineIndex >= 0 && (choiceQuestionLine.test(lines[questionLineIndex].trim()) || yesNoOptions)
  if (!explicitlyDirected && !hasClearQuestion) return null

  const question = questionLineIndex >= 0
    ? (lines[questionLineIndex].trim().replace(/^[-*+]\s+/, '').match(/^.*?\?/)?.[0] ?? lines[questionLineIndex].trim().replace(/^[-*+]\s+/, ''))
    : instructionIndex >= 0 ? lines[instructionIndex].trim().replace(/:$/, '') : 'Choose one'
  if (!question || question.length > 1200) return null

  const directive = prefix.slice(Math.max(0, instructionOffset)).join(' ')
  const mode = /\b(?:choose|select|pick|check)\s+(?:all|multiple|any|more than one)\b|\bmultiple (?:choices|options|answers)\b/i.test(directive)
    ? 'multiple' : 'single'
  const freeTextOptions = options.filter((option) => /^(?:other|something else)\b/i.test(option) && /\b(?:say what|specify|explain|describe|tell me|point to|provide|type|write)\b/i.test(option))
  const allowOther = !options.some((option) => /^(?:other|something else)\b/i.test(option)) && /\bother\s*\(?\s*(?:say what|specify|explain|describe|tell me)\b/i.test(directive)
  const removeFrom = questionLineIndex >= 0 ? questionLineIndex : instructionIndex >= 0 ? instructionIndex : firstOptionIndex
  const bodyContent = lines.slice(0, removeFrom).join('\n').trimEnd()
  const interaction = choiceInteractionSchema.parse({
    id: `${identity.messageId}:choice`, conversationId: identity.conversationId, messageId: identity.messageId,
    type: 'choice', question, mode, options, freeTextOptions, allowOther,
  })
  return { interaction, bodyContent }
}
