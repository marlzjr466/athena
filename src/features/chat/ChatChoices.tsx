import { useId, useState, type FormEvent } from 'react'

export interface ChoicePrompt { mode: 'single' | 'multiple'; options: string[] }

/** Be conservative: only a terminal option list preceded by an explicit question is interactive. */
export function parseChoicePrompt(content: string): ChoicePrompt | null {
  const withoutFences = content.replace(/```[\s\S]*?```/g, '')
  const lines = withoutFences.trim().split('\n')
  const options: string[] = []
  let index = lines.length - 1
  while (index >= 0 && !lines[index].trim()) index--
  for (; index >= 0; index--) {
    const match = /^\s{0,3}(?:[-*+] |\d+[.)] |[A-Z][.)] )(.+?)\s*$/.exec(lines[index])
    if (!match) break
    const option = match[1].replace(/^\*\*|\*\*$/g, '').replace(/^`|`$/g, '').trim()
    if (!option || option.length > 180 || /^\[[ xX]\]/.test(option)) return null
    options.unshift(option)
  }
  if (options.length < 2 || options.length > 8) return null
  const introduction = lines.slice(Math.max(0, index - 5), index + 1).join(' ').trim()
  if (!/(?:\?|\b(?:choose|select|pick|which (?:option|approach|one|of these)|would you (?:like|prefer))\b)/i.test(introduction)) return null
  if (/\b(?:for example|examples include|such as)\b/i.test(introduction)) return null
  const mode = /\b(?:select|choose|pick|check)\s+(?:all|multiple|any|more than one)\b|\bmultiple (?:choices|options|answers)\b/i.test(introduction) ? 'multiple' : 'single'
  return { mode, options: options.filter(option => !/^other(?:\s*[:—–-].*)?$/i.test(option)) }
}

export function ChatChoices({ prompt, disabled, onAnswer }: { prompt: ChoicePrompt; disabled: boolean; onAnswer(answer: string): Promise<boolean> }) {
  const name = useId()
  const [selected, setSelected] = useState<string[]>([])
  const [other, setOther] = useState('')
  const [sending, setSending] = useState(false)
  const toggle = (value: string) => setSelected(current => prompt.mode === 'single' ? [value] : current.includes(value) ? current.filter(item => item !== value) : [...current, value])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (disabled || sending || !selected.length || (selected.includes('Other') && !other.trim())) return
    const choices = [...prompt.options.filter(option => selected.includes(option)), ...(selected.includes('Other') ? [`Other: ${other.trim()}`] : [])]
    setSending(true)
    try { await onAnswer(prompt.mode === 'single' ? choices[0] : `My choices:\n${choices.map(choice => `- ${choice}`).join('\n')}`) }
    finally { setSending(false) }
  }
  return <form className="chat-choices" onSubmit={(event) => void submit(event)}><fieldset disabled={disabled || sending}><legend>{prompt.mode === 'multiple' ? 'Select all that apply' : 'Choose one'}</legend>
    {[...prompt.options, 'Other'].map(option => <label key={option} className="chat-choice"><input type={prompt.mode === 'multiple' ? 'checkbox' : 'radio'} name={name} checked={selected.includes(option)} onChange={() => toggle(option)} /><span>{option}</span></label>)}
    {selected.includes('Other') && <textarea aria-label="Explain other choice" placeholder="Tell Athena what you prefer…" value={other} onChange={event => setOther(event.target.value)} maxLength={1000} rows={2} />}
    <button type="submit" className="button primary" disabled={!selected.length || (selected.includes('Other') && !other.trim())}>{sending ? 'Sending…' : 'Send choice'}</button>
  </fieldset></form>
}
