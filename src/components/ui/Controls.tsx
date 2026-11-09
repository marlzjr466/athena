import { useEffect, useId, useState, type ReactNode } from 'react'

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange(value: boolean): void; label: string; disabled?: boolean }) {
  return <button className={`toggle ${checked ? 'is-on' : ''}`} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>
}
export function SettingRow({ title, description, children, icon }: { title: string; description?: string; children: ReactNode; icon?: ReactNode }) {
  return <div className="setting-row">{icon && <span className="setting-icon">{icon}</span>}<div className="setting-copy"><span>{title}</span>{description && <p>{description}</p>}</div>{children}</div>
}
export function Slider({ label, value, min, max, step = 1, unit = '', onChange, ends, disabled = false }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange(value: number): void; ends?: [string, string]; disabled?: boolean }) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  // Commit after a brief pause, preserving smooth input without IPC on every pixel.
  useEffect(() => {
    if (draft === value || disabled) return
    const timer = window.setTimeout(() => onChange(draft), 120)
    return () => window.clearTimeout(timer)
  }, [draft, value, onChange, disabled])
  return <div className="slider-field" style={disabled ? { opacity: 0.45 } : undefined}><div className="slider-label"><label htmlFor={id}>{label}</label><output htmlFor={id}>{Math.round(draft * 100) / 100}<span>{unit}</span></output></div>
    <input id={id} type="range" disabled={disabled} min={min} max={max} step={step} value={draft} aria-label={label} style={{ '--range-progress': `${((draft - min) / (max - min)) * 100}%` } as React.CSSProperties} onChange={(event) => setDraft(Number(event.target.value))} />
    {ends && <div className="range-ends"><span>{ends[0]}</span><span>{ends[1]}</span></div>}
  </div>
}
export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="settings-section"><div className="section-heading"><h2>{title}</h2>{description && <p>{description}</p>}</div><div className="settings-card">{children}</div></section>
}
