import { Box, Check, CircleCheck, CircleDashed, Clock3, XCircle, AlertCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import type { LocalModel } from '../../../shared/localAI'
import { CustomSelect } from '../../components/ui/CustomSelect'

export function AcademyHeader({ fine = false }: { fine?: boolean }) {
  if (!fine) return null
  return <header className="page-heading academy-page-heading"><div><div className="eyebrow">YOUR ATHENA / LOCAL AI{fine ? ' / ATHENA ACADEMY' : ''}</div><h1>{fine ? 'Advanced Model Fine-Tuning' : 'My Athena'}</h1><p>{fine ? 'Fine-tuning customizes how your selected local model responds using your own training data. This is different from adding documents to a knowledge library, which provides additional context without changing the model’s behavior.' : 'Choose the local model that powers your companion and manage its own settings.'}</p></div><span className="saved-label"><Check size={14} /> Saved automatically</span></header>
}
export function AcademyProgress({ value, label, color }: { value: number; label: string; color?: string }) {
  return <div className={`ac-progress ${color ?? ''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>
}
export function AcademyStatus({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  const Icon = tone === 'success' ? CircleCheck : tone === 'danger' ? XCircle : tone === 'warning' ? Clock3 : tone === 'blue' ? CircleDashed : AlertCircle
  return <span className={`ac-status ${tone}`}><Icon size={13} />{children}</span>
}
export function AcademyModelPanel({ model, models, onChange, children, fine = false, disabled = false }: { model?: LocalModel; models: LocalModel[]; onChange: (value: string) => void; children?: ReactNode; fine?: boolean; disabled?: boolean }) {
  return <section className={`ac-model-panel ac-panel ${fine ? 'is-fine' : ''}`} aria-label="Selected local model">
    <div className="ac-icon blue"><Box size={28} /></div><div className="ac-model-main"><div className="ac-model-heading"><div><h3>{fine ? 'Selected Local Model' : 'Local model'}</h3><p>{fine ? 'This is the model you will fine-tune. Changing this selection does not automatically switch Floating Athena or any active chat session.' : 'Each installed Ollama model has an independent Academy profile. Changing this selection does not switch Floating Athena or any chat session.'}</p></div><CustomSelect ariaLabel="Academy model" value={model?.name ?? ''} options={[{ value: '', label: 'Select an installed model', disabled: true }, ...models.map(item => ({ value: item.name, label: item.name }))]} disabled={disabled} onChange={onChange} /></div>
    <div className="ac-chips"><span>{model?.family ?? 'Architecture unknown'}</span><span>{model?.quantization ?? 'Quantization unknown'}</span><span>{model?.digest ? `Digest ${model.digest.slice(0, 12)}` : 'Digest unavailable'}</span><span>{model ? `${(model.size / 1024 ** 3).toFixed(1)} GB` : 'Size unavailable'}</span></div></div>{children && <div className="ac-model-extra">{children}</div>}
  </section>
}
export function FineStep({ number, title, description, children }: { number: number; title: string; description: string; children: ReactNode }) {
  return <section id={`fine-step-${number}`} className="ac-panel ac-fine-step" aria-labelledby={`fine-title-${number}`}><div className="ac-step-intro"><span className="ac-step-number">{number}</span><div><h3 id={`fine-title-${number}`}>{title}</h3><p>{description}</p></div></div><div className="ac-step-content">{children}</div></section>
}
