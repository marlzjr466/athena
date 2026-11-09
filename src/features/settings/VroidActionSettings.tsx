import { useState } from 'react'
import { VROID_ACTIONS, type VroidActionId } from '../../../shared/vroidActions'
import { useAthena } from '../../store/athenaStore'
import { desktop } from '../../services/desktop'
import { Section, SettingRow, Toggle } from '../../components/ui/Controls'
import { avatarName } from '../../../shared/avatarModels'
import { modelCommand } from '../../three/importAvatar'

export function VroidActionSettings() {
  const { snapshot, update } = useAthena()
  const [error, setError] = useState<string | null>(null)
  if (!snapshot) return null
  const { settings, vroidActions } = snapshot
  const model = snapshot.importedAvatars?.find(m => m.id === settings.avatarVariant)
  const name = avatarName(settings.avatarVariant, snapshot.importedAvatars)
  const enabledActions = model?.enabledActions ?? settings.vroidEnabledActions
  const random = model?.animationSettings.random ?? settings.vroidRandomActions
  const save = async (enabled: typeof enabledActions, randomEnabled = random) => {
    try {
      if (model) await modelCommand({ action: 'preferences', id: model.id, enabledActions: enabled, random: randomEnabled })
      else await update({ vroidEnabledActions: enabled, vroidRandomActions: randomEnabled })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const play = async (id: VroidActionId) => {
    try {
      const result = await desktop.playVroidAction(id)
      setError(result.ok ? null : result.message ?? 'This action could not be started.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <Section title={`${name} actions`} description="Idle plays for 3 seconds after each transition, then one enabled action plays once. Both windows follow the same animation clock. Each model has independent preferences.">
    <SettingRow title={`Random ${name} actions`} description="Pause random gestures while speaking, listening, flying, or working."><Toggle label={`Random ${name} actions`} checked={random} onChange={value => void save(enabledActions, value)} /></SettingRow>
    <p className="card-description" role="status">{vroidActions?.session ? `Playing: ${VROID_ACTIONS.find(action => action.id === vroidActions.session?.action)?.label}` : `Waiting for ${name} and its animations to load.`}</p>
    {VROID_ACTIONS.map(action => {
      const report = vroidActions?.clips.find(clip => clip.id === action.id) ?? model?.compatibleAnimations.find(clip => clip.id === action.id)
      const enabled = action.id === 'idle' || enabledActions.includes(action.id)
      return <SettingRow key={action.id} title={action.label} description={`${action.file} · ${report?.error ?? (report?.duration ? `${report.duration.toFixed(2)} seconds` : 'Not validated yet')}${action.id === 'idle' ? ' · Always available' : ''}`}>
        <button className="button secondary" aria-label={`Play ${action.label}`} disabled={!report?.duration || !enabled || vroidActions?.blocked} onClick={() => void play(action.id)}>Play</button>
        <Toggle label={`Enable ${action.label}`} checked={enabled} disabled={action.id === 'idle' || Boolean(model && !report?.duration)} onChange={on => void save(on ? [...enabledActions, action.id] : enabledActions.filter(id => id !== action.id))} />
      </SettingRow>
    })}
    {error && <p className="card-description" role="alert">{error}</p>}
  </Section>
}
