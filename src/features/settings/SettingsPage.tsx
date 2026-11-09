import { avatarName, isVrmAvatar } from '../../../shared/avatarModels'
import { useState } from 'react'
import { Check, Command, ExternalLink, Info, Monitor } from 'lucide-react'
import { useAthena } from '../../store/athenaStore'
import { Section, SettingRow, Slider, Toggle } from '../../components/ui/Controls'
import type { Settings } from '../../../shared/settings'
import { MIN_WANDER_INTERVAL, MAX_WANDER_INTERVAL, MIN_MOVEMENT_SPEED, MAX_MOVEMENT_SPEED } from '../../../shared/settings'
import { WANDER_POSITIONS } from '../../../shared/flight'
import { ACTION_DEFINITIONS, IDLE_ACTIONS } from '../../../shared/idleActions'
import { Logo } from '../../components/shared/Logo'
import { AISettings } from './AISettings'
import { PermissionSettings } from './PermissionSettings'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { VoiceSettings } from './VoiceSettings'
import { VroidActionSettings } from './VroidActionSettings'

const metadata: Record<string, [string, string]> = {
  general: ['Make yourself at home.', 'The little details that make Athena part of your day.'],
  appearance: ['A companion, your way.', 'Fine-tune Athena’s presence. Every change feels at home.'],
  floating: ['Give her a little space.', 'Set the rhythm and boundaries of life on your desktop.'],
  shortcuts: ['Always within reach.', 'A familiar gesture is all it takes.'],
  privacy: ['Your desktop. Your trust.', 'A quiet companion should respect your space.'],
  about: ['Small presence. Big ideas.', 'Your intelligent companion, alive on your desktop.'],
}
export function SettingsPage({ page }: { page: string }) {
  const { snapshot, update, command } = useAthena()
  const [openShortcut, setOpenShortcut] = useState<string | null>(null)
  const [toggleShortcut, setToggleShortcut] = useState<string | null>(null)
  if (page === 'ai') return <AISettings />
  if (page === 'voice') return <VoiceSettings />
  if (!snapshot) return null
  const s = snapshot.settings
  const name = avatarName(s.avatarVariant, snapshot.importedAvatars)
  const toggle = (key: keyof Settings, title: string, description: string) => <SettingRow key={key} title={title} description={description}><Toggle label={title} checked={Boolean(s[key])} onChange={(value) => void update({ [key]: value })} /></SettingRow>
  const [title, subtitle] = metadata[page] ?? metadata.general
  return <div className="settings-page"><div className="page-heading"><div><div className="eyebrow">YOUR ATHENA / {page.toUpperCase()}</div><h1>{title}</h1><p>{subtitle}</p></div><span className="saved-label"><Check size={14} /> Saved automatically</span></div>
    {page === 'general' && <>
      <Section title="A familiar start" description="Choose how Athena joins your day.">
        {toggle('launchAtLogin', 'Launch at login', 'Start Athena when you sign in. Requires the installed app.')}
        {toggle('startHidden', 'Start quietly', 'Start in the tray with the companion and control center hidden.')}
        {toggle('minimizeToTray', 'Keep Athena in the tray', 'Closing the control center keeps your companion running.')}
      </Section>
      <Section title="A little peace and quiet">
        {toggle('doNotDisturb', 'Do not disturb', 'Pause wandering and keep animation to a minimum.')}
        {toggle('reduceOnBattery', 'Go gently on battery', 'Reduce animation and particles while unplugged. Wandering keeps its interval.')}
        {toggle('reducedMotion', 'Reduce motion', 'Keep Athena still and turn off particles. System preferences also apply.')}
      </Section>
    </>}
    {page === 'notifications' && <Section title="Attention and updates" description="Pending approvals remain in their conversation until you choose an action. OS notification permissions may also limit desktop delivery.">
      <div className="ai-context-settings">
        <label><span>Enable approval notifications</span><input type="checkbox" checked={s.notificationPreferences.approvals} onChange={(event) => void update({ notificationPreferences: { ...s.notificationPreferences, approvals: event.target.checked } })} /></label>
        <label><span>Show pending approval badges</span><input type="checkbox" checked={s.notificationPreferences.approvalBadges} onChange={(event) => void update({ notificationPreferences: { ...s.notificationPreferences, approvalBadges: event.target.checked } })} /></label>
        <label><span>Play notification sounds</span><input type="checkbox" checked={s.notificationPreferences.sound} onChange={(event) => void update({ notificationPreferences: { ...s.notificationPreferences, sound: event.target.checked } })} /></label>
        <label><span>Show safe action summaries</span><input type="checkbox" checked={s.notificationPreferences.preview} onChange={(event) => void update({ notificationPreferences: { ...s.notificationPreferences, preview: event.target.checked } })} /></label>
        <label><span>Suppress desktop alerts during Do Not Disturb</span><input type="checkbox" checked={s.notificationPreferences.suppressDuringDnd} onChange={(event) => void update({ notificationPreferences: { ...s.notificationPreferences, suppressDuringDnd: event.target.checked } })} /></label>
        <label><span>Notify when a background task completes</span><input type="checkbox" checked={s.backgroundTasks.notifyComplete} onChange={(event) => void update({ backgroundTasks: { ...s.backgroundTasks, notifyComplete: event.target.checked } })} /></label>
        <label><span>Notify when a background task fails</span><input type="checkbox" checked={s.backgroundTasks.notifyFailed} onChange={(event) => void update({ backgroundTasks: { ...s.backgroundTasks, notifyFailed: event.target.checked } })} /></label>
        <label><span>Show Dock or taskbar completion badges</span><input type="checkbox" checked={s.backgroundTasks.badge} onChange={(event) => void update({ backgroundTasks: { ...s.backgroundTasks, badge: event.target.checked } })} /></label>
        <label><span>Allow native desktop notifications</span><input type="checkbox" checked={s.backgroundTasks.nativeNotifications} onChange={(event) => void update({ backgroundTasks: { ...s.backgroundTasks, nativeNotifications: event.target.checked } })} /></label>
      </div>
    </Section>}
    {page === 'appearance' && <>
      <Section title={`${name} · Presence`} description="A good companion never takes up too much space."><div className="slider-row"><Slider label={`${name} size`} value={s.size} min={80} max={400} unit=" px" onChange={(size) => void update({ size })} ends={['80 px · Tiny', '400 px · Room to shine']} /></div>
        <div className="slider-row"><Slider label="Glow intensity" value={s.glowIntensity} min={0} max={2} step={0.05} onChange={(glowIntensity) => void update({ glowIntensity })} ends={['Subtle', 'Radiant']} /></div>
        <div className="slider-row"><Slider label="Particles" value={s.particleIntensity} min={0} max={1} step={0.05} onChange={(particleIntensity) => void update({ particleIntensity })} ends={['None', 'A little stardust']} /></div>
        <div className="slider-row"><Slider label="Animation intensity" value={s.animationIntensity} min={0} max={1} step={0.05} onChange={(animationIntensity) => void update({ animationIntensity })} /></div>
        {toggle('hoverAnimation', 'Idle hover', 'A gentle rise and fall, like taking a breath.')}
      </Section>
      <Section title="Comfort & performance"><SettingRow title="Render quality" description="Balanced runs at 30 frames per second."><CustomSelect ariaLabel="Render quality" value={s.renderQuality} options={[{ value: 'performance', label: 'Performance · 20 fps' }, { value: 'balanced', label: 'Balanced · 30 fps' }, { value: 'quality', label: 'Quality · 45 fps' }]} onChange={(renderQuality) => void update({ renderQuality: renderQuality as Settings['renderQuality'] })} /></SettingRow><div className="slider-row"><Slider label="Interface scale" value={s.uiScale} min={0.85} max={1.2} step={0.05} unit="×" onChange={(uiScale) => void update({ uiScale })} /></div></Section>
    </>}
    {page === 'floating' && <>
      <Section title="Life on your desktop">
        {toggle('floatingEnabled', `Floating ${name}`, `Show ${name} above your desktop applications.`)}
        {toggle('alwaysOnTop', 'Stay above applications', `Keep ${name} visible above ordinary windows.`)}
        {toggle('randomMovement', 'Free to Wander', `Allow ${name} to occasionally move around your desktop.`)}
        <SettingRow title={`Pin ${name} here`} description="Stay in the current location until you unpin."><Toggle label={`Pin ${name} here`} checked={s.pinned} onChange={(value) => void command(value ? 'pin' : 'unpin')} /></SettingRow>
        <div className="slider-row"><Slider label="Movement interval" value={s.wanderIntervalSeconds} min={MIN_WANDER_INTERVAL} max={MAX_WANDER_INTERVAL} unit=" seconds" disabled={!s.randomMovement} onChange={(wanderIntervalSeconds) => void update({ wanderIntervalSeconds })} ends={['10 sec', '5 min']} /><p className="card-description">How often Athena changes her position while wandering. The countdown starts after each glide, drag, or interaction.</p></div>
        <div className="slider-row"><Slider label="Movement speed" value={s.movementSpeed} min={MIN_MOVEMENT_SPEED} max={MAX_MOVEMENT_SPEED} step={0.1} unit="×" onChange={(movementSpeed) => void update({ movementSpeed })} ends={['0.5× · Very slow', '10× · Maximum']} /><p className="card-description">How fast Athena flies between positions. She turns into flight, then softly stabilizes on arrival.</p></div>
      </Section>
      <Section title="Floating task visuals" description="When Athena works, she can hold position and show compact holograms for the current activity.">
        {toggle('taskActivityEnabled', 'Task activity animation', 'Focus Athena during her local chat, tool use, voice responses, and coding tasks.')}
        {toggle('taskHologramsEnabled', 'Show task screen', 'A curved 3D console with a rear three-quarter working pose and activity-aware touch gestures.')}
        {toggle('taskDetailedHolograms', 'Detailed task screen', 'Show a little more activity context inside Athena’s working screen.')}
        <div className="slider-row"><Slider label="Task animation intensity" value={s.taskAnimationIntensity} min={0} max={1} step={0.05} disabled={!s.taskActivityEnabled} onChange={(taskAnimationIntensity) => void update({ taskAnimationIntensity })} ends={['Very subtle', 'More expressive']} /></div>
        {toggle('taskCompletionNotification', 'Completion notification', 'Show a brief finish, failure, or cancellation animation.')}
        {toggle('pauseFloatingWhileWorking', 'Pause floating while working', 'Also pause travel when task visuals are off. Working Mode always holds position.')}
      </Section>
      <Section title="Wander positions" description="Choose Athena’s stops. Keep at least one enabled; with one stop she stays there.">
        {WANDER_POSITIONS.map((id) => {
          const label = id.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ')
          return <SettingRow key={id} title={label}><Toggle label={label} checked={s.enabledPositions.includes(id)} disabled={s.enabledPositions.length === 1 && s.enabledPositions.includes(id)} onChange={(enabled) => void update({ enabledPositions: enabled ? [...s.enabledPositions, id] : s.enabledPositions.filter((value) => value !== id) })} /></SettingRow>
        })}
      </Section>
      {isVrmAvatar(s.avatarVariant) ? <VroidActionSettings /> : <Section title="Random actions" description="Little moments of personality while resting at an enabled stop. Actions pause for flight, dragging and interaction.">
        {toggle('randomActions', 'Random Actions', 'Let Athena occasionally wave, stretch, or play while idle.')}
        <div className="slider-row"><Slider label="Action interval" value={s.actionIntervalSeconds} min={10} max={300} unit=" seconds" disabled={!s.randomActions} onChange={(actionIntervalSeconds) => void update({ actionIntervalSeconds })} ends={['10 sec', '5 min']} /><p className="card-description">Wait time after arriving or finishing an action. A due flight lets a short action finish first.</p></div>
        {IDLE_ACTIONS.map((id) => <SettingRow key={id} title={ACTION_DEFINITIONS[id].label}><Toggle label={ACTION_DEFINITIONS[id].label} checked={s.enabledActions.includes(id)} onChange={(enabled) => void update({ enabledActions: enabled ? [...s.enabledActions, id] : s.enabledActions.filter((value) => value !== id) })} /></SettingRow>)}
        {s.enabledActions.length === 0 && <p className="card-description" role="status">All actions are off. Athena will rest quietly.</p>}
      </Section>}
      <Section title="A place to call home" description="Athena stays inside the usable display area, clear of the Dock and menu bar."><SettingRow title="Floating monitor" description="Automatic wandering stays on one display."><CustomSelect ariaLabel="Floating monitor" value={s.monitorMode} options={[{ value: 'current', label: 'Current display' }, { value: 'primary', label: 'Primary display' }, { value: 'selected', label: 'Selected display' }]} onChange={(monitorMode) => void update({ monitorMode: monitorMode as Settings['monitorMode'] })} /></SettingRow>
        {s.monitorMode === 'selected' && <SettingRow title="Selected display"><CustomSelect ariaLabel="Selected display" value={String(s.selectedDisplay ?? snapshot.displays[0]?.id ?? '')} options={snapshot.displays.map((display) => ({ value: String(display.id), label: `${display.label}${display.primary ? ' · Primary' : ''}` }))} onChange={(display) => void update({ selectedDisplay: Number(display) })} /></SettingRow>}
        {toggle('crossMonitor', 'Drag between displays', 'Allow manual dragging onto another connected monitor.')}
        <SettingRow title="Move to another display" description={`${snapshot.displays.length} display${snapshot.displays.length === 1 ? '' : 's'} connected`}><button className="button secondary" disabled={snapshot.displays.length < 2} onClick={() => void command('next-monitor')}><Monitor size={15} /> Move Athena</button></SettingRow>
      </Section>
    </>}
    {page === 'shortcuts' && <Section title="A quick hello" description="Use Electron accelerator names, for example CommandOrControl+Shift+Space."><SettingRow title="Open Athena" description="Bring the control center into view."><input className="shortcut-input" aria-label="Open Athena shortcut" value={openShortcut ?? s.shortcutOpen} onChange={(event) => setOpenShortcut(event.target.value)} /></SettingRow><SettingRow title="Show / hide Athena" description="A little company, only when you want it."><input className="shortcut-input" aria-label="Show or hide shortcut" value={toggleShortcut ?? s.shortcutToggle} onChange={(event) => setToggleShortcut(event.target.value)} /></SettingRow><div className="settings-actions"><span><Command size={14} /> Unavailable shortcuts show an error.</span><button className="button primary" onClick={() => void update({ shortcutOpen: openShortcut ?? s.shortcutOpen, shortcutToggle: toggleShortcut ?? s.shortcutToggle })}>Save shortcuts</button></div></Section>}
    {page === 'privacy' && <>
      <PermissionSettings />
      <Section title="What Athena remembers"><SettingRow title="Your preferences" description="Size, position, appearance, floating behavior, and shortcuts are stored locally."><Check size={18} className="text-accent" /></SettingRow><SettingRow title="Conversation history" description="Conversations, drafts and sent voice transcripts are saved on this Mac. Recordings are not saved. Online Conversation uses the provider selected in AI; floating Athena uses the local model selected in My Athena."><Check size={18} className="text-accent" /></SettingRow></Section>
    </>}
    {page === 'shortcuts' && <Section title="Push to talk"><SettingRow title="Hold ⌘ / Ctrl + Shift + A" description="Available while Conversation is focused. Release to transcribe, review, then send. Escape cancels. In chat, click the microphone once to start and again to finish; Space / Enter follows the same toggle behavior."><Command size={18} /></SettingRow></Section>}
    {page === 'about' && <section className="about-card"><Logo /><h2>ATHENA</h2><span className="subtle-badge">DESKTOP COMPANION · {snapshot.version}</span><p>Your intelligent companion,<br />alive on your desktop.</p><div className="about-note"><Info size={18} /><span>A real floating companion with OpenAI chat, push-to-talk input, optional spoken replies, and permission-controlled project tools.</span></div><button className="button secondary" onClick={() => useAthena.getState().setPage('companion')}>Meet your companion <ExternalLink size={15} /></button></section>}
  </div>
}
