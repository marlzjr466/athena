// Deliberately anchored: quoted examples are not commands. A plain stop during
// an active voice interaction cancels automation as well as speech.
export function voiceControlIntent(text: string): 'stop-speech' | 'cancel-task' | undefined {
  const command = text.trim().replace(/^(?:hey[, ]+)?athena[,! ]*/i, '').replace(/[.!?]+$/, '').trim()
  if (/^(?:please )?(?:stop talking|stop speaking|be quiet)(?: please)?$/i.test(command)) return 'stop-speech'
  if (/^(?:please )?(?:stop|cancel (?:the |my )?(?:current )?(?:task|automation)|stop (?:the |my )?(?:current )?(?:task|automation)|stop working|cancel that)(?: please)?$/i.test(command)) return 'cancel-task'
}
