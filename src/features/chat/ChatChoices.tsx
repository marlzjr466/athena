import { useId, useState, type FormEvent } from 'react'
import { parseChoiceInteraction, type ChoiceInteraction } from '../../../shared/chatInteraction'

export { parseChoiceInteraction }

/** Compatibility shape retained for existing callers and focused parser tests. */
export interface ChoicePrompt { mode: 'single' | 'multiple'; options: string[] }
export function parseChoicePrompt(content: string): ChoicePrompt | null {
  const parsed = parseChoiceInteraction(content, { conversationId: 'compat', messageId: 'compat' })
  return parsed ? { mode: parsed.interaction.mode, options: parsed.interaction.options.filter(option => !parsed.interaction.freeTextOptions.includes(option) && !/^other(?:\s*[:—–-].*)?$/i.test(option)) } : null
}

export function ChatChoices({ interaction, disabled, onAnswer }: { interaction: ChoiceInteraction; disabled: boolean; onAnswer(answer: string): Promise<boolean> }) {
  const name = useId()
  const [selected, setSelected] = useState<string[]>([])
  const [other, setOther] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [failed, setFailed] = useState(false)
  const selectedNeedsText = selected.some(option => interaction.freeTextOptions.includes(option)) || (interaction.allowOther && selected.includes('Other'))
  const toggle = (value: string) => {
    setFailed(false)
    setSelected(current => interaction.mode === 'single' ? [value] : current.includes(value) ? current.filter(item => item !== value) : [...current, value])
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (disabled || sending || sent || !selected.length || (selectedNeedsText && !other.trim())) return
    const choices = selected.map(choice => {
      if (interaction.freeTextOptions.includes(choice)) return `${choice}: ${other.trim()}`
      if (choice === 'Other' && interaction.allowOther) return `Other: ${other.trim()}`
      return choice
    })
    setSending(true)
    setFailed(false)
    try {
      const accepted = await onAnswer(interaction.mode === 'single' ? choices[0] : `My choices:\n${choices.map(choice => `- ${choice}`).join('\n')}`)
      if (accepted) setSent(true)
      else setFailed(true)
    } catch { setFailed(true) }
    finally { setSending(false) }
  }
  const options = [...interaction.options, ...(interaction.allowOther ? ['Other'] : [])]
  const alreadyAnswered = interaction.status === 'answered'
  return <form className="chat-choices" onSubmit={(event) => void submit(event)}>
    <fieldset disabled={disabled || sending || sent || alreadyAnswered}>
      <legend>{interaction.question}</legend>
      {options.map((option, index) => <label key={`${index}-${option}`} className="chat-choice">
        <input type={interaction.mode === 'multiple' ? 'checkbox' : 'radio'} name={name} checked={selected.includes(option) || (alreadyAnswered && (interaction.answer === option || interaction.answer?.startsWith(`${option}:`) === true || interaction.answer?.includes(`- ${option}`) === true))} onChange={() => toggle(option)} />
        <span>{option}</span>
      </label>)}
      {selectedNeedsText && <textarea aria-label="Explain your choice" placeholder="Add your answer…" value={other} onChange={event => { setOther(event.target.value); setFailed(false) }} maxLength={1000} rows={2} />}
      {alreadyAnswered && interaction.answer && <p className="chat-message-note">Answer sent: {interaction.answer}</p>}
      <button type="submit" className="button primary" disabled={alreadyAnswered || !selected.length || (selectedNeedsText && !other.trim())}>{alreadyAnswered || sent ? 'Choice sent' : sending ? 'Sending…' : 'Send choice'}</button>
      {failed && <p role="alert" className="chat-error">Athena could not send that choice. Your selection is saved here; try again.</p>}
    </fieldset>
  </form>
}
