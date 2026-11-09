// Deliberately exact: quoted examples or an ambiguous "stop" are not task
// cancellation commands. All other instructions still use the normal agent.
export function voiceControlIntent(text: string): 'stop-speech' | 'cancel-task' | undefined {
  const command = text.trim().replace(/^(?:hey[, ]+)?athena[,! ]*/i, '').replace(/[.!?]+$/, '').trim()
  if (/^(?:please )?(?:stop talking|stop speaking|be quiet)(?: please)?$/i.test(command)) return 'stop-speech'
  if (/^(?:please )?(?:cancel (?:the |my )?(?:current )?task|stop (?:the |my )?(?:current )?task|stop working|cancel that)(?: please)?$/i.test(command)) return 'cancel-task'
}
