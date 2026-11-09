import { ArrowDownLeft, ArrowUpRight, Check, Fingerprint, Monitor, MoreHorizontal, MoveUpRight, Pin, SlidersHorizontal, Sparkles, WandSparkles } from 'lucide-react'
import { motion } from 'framer-motion'
import { CompanionShowcase } from './CompanionShowcase'
import './companionShowcase.css'
import { useAthena } from '../../store/athenaStore'
import { SettingRow, Slider, Toggle } from '../../components/ui/Controls'
import { avatarName } from '../../../shared/avatarModels'
import { SIZE } from '../../../shared/settings'

const SHOW_ENERGY_FX = false

export function CompanionPage() {
  const { snapshot, update, command, setPage } = useAthena()
  if (!snapshot) return null
  const { settings, visible } = snapshot
  const name = avatarName(settings.avatarVariant, snapshot.importedAvatars)
  return <motion.div className="companion-page" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
    <div className="page-heading"><div><div className="eyebrow"><span /> YOUR DESKTOP, REIMAGINED</div><h1>A little presence.<br /><span>A world of possibility.</span></h1><p>Meet Athena. Your own little corner of the future.</p></div><button className="button secondary compact" onClick={() => setPage('appearance')}><SlidersHorizontal size={15} /> Customize</button></div>
    <div className="companion-layout">
      <CompanionShowcase snapshot={snapshot}>
        <div className="companion-panel-controls">
          <section><div className="card-title"><h2>On your desktop</h2><span className={`subtle-badge ${visible ? 'active' : ''}`}>{visible ? 'LIVE' : 'HIDDEN'}</span></div><p className="card-description">A companion, wherever you work.</p>
          <SettingRow title={`Floating ${name}`} description="A little life above your windows" icon={<Sparkles size={17} />}><Toggle label={`Floating ${name}`} checked={visible} onChange={(value) => void command(value ? 'show' : 'hide')} /></SettingRow>
          <SettingRow title="Free to wander" description={settings.pinned ? 'Paused while pinned' : settings.doNotDisturb ? 'Paused · Do not disturb' : settings.reducedMotion || snapshot.reducedMotion ? 'Paused · Reduced motion' : `A new spot every ${settings.wanderIntervalSeconds} seconds`} icon={<MoveUpRight size={17} />}><Toggle label="Random movement" checked={settings.randomMovement} onChange={(value) => void update({ randomMovement: value })} /></SettingRow>
          <SettingRow title="Stay here" description={`Pin ${name} in one spot`} icon={<Pin size={17} />}><Toggle label={`Pin ${name}`} checked={settings.pinned} onChange={(value) => void command(value ? 'pin' : 'unpin')} /></SettingRow>
          </section>
          <div className="companion-section-divider" role="separator" />
          <section><div className="card-title"><h2>Just the right size</h2><ArrowDownLeft size={16} /></div><Slider label={`${name} size`} value={settings.size} min={SIZE.min} max={SIZE.max} unit=" px" onChange={(size) => void update({ size })} ends={['Small', 'Large']} /><div className="size-presets">{[{ label: 'Small', value: 120 }, { label: 'Medium', value: 180 }, { label: 'Large', value: 280 }].map(({ label, value }) => <button key={label} className={settings.size === value ? 'selected' : ''} onClick={() => void update({ size: value })}>{label}{settings.size === value && <Check size={12} />}</button>)}</div></section>
        </div>
        {SHOW_ENERGY_FX && <div className="showcase-energy"><div><Sparkles size={18} /><strong>Energy FX</strong><Toggle label="Energy FX" checked={settings.avatarEnergyFX} onChange={value => void update({ avatarEnergyFX: value })} /></div><p>Ambient energy around Enhanced Athena. Her eyes and signature glow stay on.</p></div>}
      </CompanionShowcase>
    </div>
    <div className="section-caption"><span>MADE TO FIT YOUR WORLD</span><span>Quietly capable. Always yours.</span></div>
    <div className="feature-cards">
      <button className="feature-card" onClick={() => setPage('floating')}><span className="feature-icon"><Monitor size={19} /></span><h3>At home on your screen <ArrowUpRight size={14} /></h3><p>A gentle wanderer, or a familiar face<br />right where you leave her.</p><span className="feature-link">Floating preferences</span></button>
      <button className="feature-card" onClick={() => setPage('appearance')}><span className="feature-icon"><WandSparkles size={19} /></span><h3>A little more you <ArrowUpRight size={14} /></h3><p>Find the size, glow, and motion<br />that feel right in your space.</p><span className="feature-link">Make Athena yours</span></button>
      <button className="feature-card" onClick={() => setPage('privacy')}><span className="feature-icon"><Fingerprint size={19} /></span><h3>Your space stays yours <ArrowUpRight size={14} /></h3><p>Local companion. Optional OpenAI.<br />Microphone only with your permission.</p><span className="feature-link">Privacy, by default</span></button>
    </div>
    <div className="page-footnote"><span><span className="status-dot" /> Companion runs locally</span><span>Built for a calmer kind of computing <MoreHorizontal size={15} /></span></div>
  </motion.div>
}
