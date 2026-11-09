import { Section, SettingRow, Toggle } from '../../components/ui/Controls'
import { useAthena } from '../../store/athenaStore'
import type { AutomationPermission } from '../../../shared/automation'

const rows: Array<{ key: AutomationPermission; title: string; description: string }> = [
  { key: 'internalNavigation', title: 'Athena navigation', description: 'Let the local assistant open Athena pages and conversation history.' },
  { key: 'conversationManagement', title: 'Conversation management', description: 'Let the local assistant create, open, switch, rename, and stop Athena conversations.' },
  { key: 'browserAccess', title: 'Public internet access', description: 'Allow the local assistant to search public websites and read public pages. Also enable Internet Access above.' },
  { key: 'desktopApplicationControl', title: 'Desktop application control', description: 'Allow supported open and focus actions. Accessible control also needs Accessibility UI Control under Privacy.' },
  { key: 'fileReading', title: 'File reading', description: 'Use the files and projects you explicitly authorize under Privacy.' },
  { key: 'fileModification', title: 'File modification', description: 'Allow edits within an explicitly authorized project, subject to its conversation permission mode.' },
  { key: 'terminalExecution', title: 'Terminal execution', description: 'Allow bounded commands within an authorized project when its permission mode allows them.' },
  { key: 'externalMessageSubmission', title: 'External message submission', description: 'Allow an explicit local request to submit dictated text to the selected online conversation provider. Athena never reads that provider’s response aloud.' },
  { key: 'destructiveOperations', title: 'Destructive operations', description: 'Allow delete actions after a separate confirmation dialog.' },
]

export function AutomationPermissionsSettings() {
  const { snapshot, update } = useAthena()
  const permissions = snapshot?.settings.automationPermissions
  if (!permissions) return null
  return <Section title="Automation permissions" description="Floating Athena reasons with your selected local model. Categories start disabled and are checked again when an action runs.">
    {rows.map(({ key, title, description }) => <SettingRow key={key} title={title} description={description}>
      <Toggle label={title} checked={permissions[key]} onChange={(enabled) => void update({ automationPermissions: { ...permissions, [key]: enabled } })} />
    </SettingRow>)}
  </Section>
}
