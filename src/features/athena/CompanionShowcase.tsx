import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Hand, Plus } from 'lucide-react'
import { avatarName, isVrmAvatar, type ImportedAvatar } from '../../../shared/avatarModels'
import { ModelDialog } from './ModelDialog'
import { ModelCardMenu } from './ModelCardMenu'
import { integrateImportedAvatar, modelCommand } from '../../three/importAvatar'
import { CompanionAvatarThumbnail, CompanionShowcaseScene } from '../../three/CompanionShowcaseScene'
import { AVATAR_LABELS, type AvatarVariant } from '../../three/showcaseMotion'
import { useVisibility } from '../../hooks/useVisibility'
import { useAthena } from '../../store/athenaStore'
import type { Snapshot } from '../../../shared/contracts'
import { desktop } from '../../services/desktop'

const AVATARS = ['classic', 'enhanced', 'vroid-athena'] as const
// Keep the existing models available to the renderer and settings. The picker
// temporarily presents only VRoid while its companion experience is refined.
const VISIBLE_AVATARS: readonly AvatarVariant[] = AVATARS.filter(variant => variant === 'vroid-athena')

export function CompanionShowcase({ snapshot, children }: { snapshot: Snapshot; children?: ReactNode }) {
  const { settings } = snapshot
  const update = useAthena(s => s.update)
  const selected = settings.avatarVariant
  const models = snapshot.importedAvatars ?? []
  const [dialog, setDialog] = useState<'add' | ImportedAvatar | null>(null)
  const [remove, setRemove] = useState<ImportedAvatar | null>(null)
  const [modelError, setModelError] = useState('')
  const saveLock = useRef(false)
  const mounted = useRef(true)
  const [saving, setSaving] = useState(false)
  const [greeting, setGreeting] = useState(false)
  const [vroidError, setVroidError] = useState<string | null>(null)
  const waveTimer = useRef<number | undefined>(undefined)
  const region = useRef<HTMLElement>(null)
  const [inView, setInView] = useState(true)
  const [systemReduced, setSystemReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const visible = useVisibility()
  const reduced = settings.reducedMotion || snapshot.reducedMotion || systemReduced || settings.doNotDisturb
  const economy = settings.reduceOnBattery && snapshot.onBattery

  useEffect(() => {
    mounted.current = true
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setSystemReduced(media.matches)
    media.addEventListener('change', change)
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => setInView(entries[0]?.isIntersecting ?? false), { threshold: .05 })
    if (region.current) observer?.observe(region.current)
    return () => {
      mounted.current = false
      media.removeEventListener('change', change)
      observer?.disconnect()
      window.clearTimeout(waveTimer.current)
    }
  }, [])

  const select = async (next: AvatarVariant) => {
    if (saveLock.current || selected === next) return
    saveLock.current = true
    setSaving(true)
    try { await update({ avatarVariant: next }) }
    finally { saveLock.current = false; if (mounted.current) setSaving(false) }
  }

  const wave = () => {
    if (isVrmAvatar(selected)) {
      void desktop.playVroidAction('greeting').then(result => { if (!result.ok) setVroidError(result.message ?? 'Greeting unavailable.') }).catch(error => setVroidError(String(error)))
      return
    }
    window.clearTimeout(waveTimer.current)
    setGreeting(true)
    waveTimer.current = window.setTimeout(() => setGreeting(false), 1600)
  }

  return <>
    {dialog && <ModelDialog models={models} rename={dialog === 'add' ? undefined : dialog} onClose={() => setDialog(null)} />}
    {remove && <ModelDialog models={models} remove={remove} onClose={() => setRemove(null)} />}
    <section ref={region} className="companion-avatar-section" data-reduced-motion={reduced} aria-label="Athena avatar preview">
      <div className="showcase-preview">
        <div className="showcase-viewport">
          <CompanionShowcaseScene selected={selected} energyFX={settings.avatarEnergyFX} greeting={greeting} settings={settings} reduced={reduced} economy={economy} active={visible && inView} activity={snapshot} onVroidError={setVroidError} />
        </div>
        <div className="showcase-preview-footer"><span className="showcase-live"><span className="status-dot" /> {vroidError && isVrmAvatar(selected) ? `${avatarName(selected, models)} unavailable · see loading error` : `${avatarName(selected, models)} is active`}</span><button className="showcase-wave" onClick={wave} aria-label={`Wave to ${avatarName(selected, models)}`}><Hand size={15} /> Say hello</button></div>
      </div>
      <aside className="showcase-model-panel" aria-label="Choose your Avatar">
        <div className="showcase-panel-header">
          <div className="showcase-heading"><span className="eyebrow"><span /> YOUR COMPANION</span><h2>Choose your <span>Avatar</span></h2></div>
        </div>
        <div className="showcase-panel-content">
          <p className="showcase-panel-description">Select the 3D companion that fits your style.</p>
          <div className="showcase-selection">
            <h3>Available avatars</h3>
            <div className="showcase-options" role="group" aria-label="Select active avatar">
              {VISIBLE_AVATARS.map(variant => <button key={variant} className="showcase-option" data-avatar={variant} aria-label={AVATAR_LABELS[variant]} aria-pressed={selected === variant} disabled={saving} onClick={() => void select(variant)}>
                <span className="showcase-thumbnail"><CompanionAvatarThumbnail variant={variant} glow={settings.glowIntensity} />{selected === variant && <span className="showcase-selected-indicator"><Check size={12} /></span>}</span>
                <span className="showcase-option-label"><span className="showcase-option-name">{AVATAR_LABELS[variant]}</span><span className="showcase-option-badge">Default</span></span>
              </button>)}
              {models.map(model => <div className="imported-model-card" key={model.id}>
                <button className="showcase-option" data-avatar="vroid-athena" aria-label={model.name} title={`${model.name} · ${model.importStatus === 'ready' ? 'Ready to use' : model.stage}`} aria-pressed={selected === model.id} disabled={saving || model.importStatus !== 'ready'} onClick={() => void select(model.id)}>
                  <span className="showcase-thumbnail"><CompanionAvatarThumbnail variant={model.id} model={model} glow={settings.glowIntensity} />{selected === model.id && <span className="showcase-selected-indicator"><Check size={12} /></span>}</span>
                  {model.importStatus === 'ready' ? <span className="showcase-option-label"><span className="showcase-option-name">{model.name}</span><span className="showcase-option-badge">Imported</span></span> : <span className="model-import-status" role="status"><strong>{model.name}</strong>{model.importStatus === 'processing' ? <><progress aria-label={`${model.name}: ${model.stage}`} /><span>{model.stage}</span></> : <span title={model.importError}>Import failed</span>}</span>}
                </button>
                {model.importStatus !== 'processing' && <ModelCardMenu model={model} onRename={() => setDialog(model)} onDelete={() => setRemove(model)} />}
                {model.importStatus === 'error' && <div className="model-import-error"><span role="alert">{model.importError}</span><button className="button secondary" onClick={() => { void modelCommand({ action: 'retry', id: model.id }).then(result => result.model && integrateImportedAvatar(result.model)).catch(error => setModelError(String(error))) }}>Retry</button></div>}
              </div>)}
              <button className="showcase-option showcase-add-model" aria-label="Add Model" onClick={() => setDialog('add')}><span className="showcase-add-icon"><Plus size={23} /></span><span className="showcase-option-name">Add Model</span></button>
            </div>
            {modelError && <p role="alert">{modelError}</p>}
          </div>
        </div>
      </aside>
    </section>
    <aside className="companion-settings-panel showcase-panel" aria-label="Companion settings">{children}</aside>
  </>
}
