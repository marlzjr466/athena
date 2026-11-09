import { useState } from 'react'
import { generationDefaults, generationSettingsSchema } from '../../../shared/generation'
import { modelLimits } from '../../../shared/modelLimits'
import { outputBudget } from '../../../shared/outputPolicy'
import { useAthena } from '../../store/athenaStore'
import { Section } from '../../components/ui/Controls'

export function GenerationSettings({ model }: { model: string | null }) {
  const { snapshot, update, error } = useAthena(), [saving, setSaving] = useState(false), [notice, setNotice] = useState('')
  const settings = snapshot?.settings.aiGeneration ?? generationDefaults(), limits = modelLimits(model ?? '')
  return <Section title="Output & automatic continuation" description="Applies to new requests in every conversation. Models are checked again against each conversation’s selected model.">
    <form className="generation-settings" key={`${JSON.stringify(settings)}-${model}`} onSubmit={async (event) => {
      event.preventDefault()
      const data = new FormData(event.currentTarget), raw = String(data.get('output') ?? '')
      const parsed = generationSettingsSchema.safeParse({ outputTokens: raw ? Number(raw) : null, maxOutputContinuations: Number(data.get('continuations')) })
      if (!parsed.success || (parsed.data.outputTokens !== null && parsed.data.outputTokens > limits.output)) { setNotice('Choose an output budget within the displayed model limit.'); return }
      setSaving(true); setNotice('')
      await update({ aiGeneration: parsed.data }); setSaving(false)
      if (!useAthena.getState().error) setNotice('Generation settings saved. Applies to the next request.')
    }}>
      <label>Output budget per request (tokens)<input name="output" aria-label="Output budget per request" type="number" min="1024" max={limits.output} step="1" placeholder="Automatic" defaultValue={settings.outputTokens ?? ''} disabled={!snapshot || saving} /></label>
      <p>Leave blank for Automatic: starts at {outputBudget(model ?? '', null).toLocaleString()} tokens and can expand during recovery. Includes reasoning and tool arguments. {limits.verified ? 'Model maximum' : 'Unverified model — conservative maximum'}: {limits.output.toLocaleString()} tokens. A smaller model clamps the saved budget to its limit.</p>
      <label>Maximum output continuations<input name="continuations" aria-label="Maximum output continuations" type="number" min="0" max="8" step="1" defaultValue={settings.maxOutputContinuations} disabled={!snapshot || saving} /></label>
      <p>Auto reasoning starts at Medium when supported and may use Low during recovery. Your explicit reasoning choice stays in effect. Set a per-task dollar cap below in Context &amp; task limits.</p>
      <button className="button secondary" disabled={!snapshot || saving} type="submit">{saving ? 'Saving…' : 'Save generation settings'}</button>
      {(notice || error) && <p role={error ? 'alert' : 'status'}>{error || notice}</p>}
    </form>
  </Section>
}
