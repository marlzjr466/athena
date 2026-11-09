import { useEffect, useState } from 'react'
import { Section } from '../../components/ui/Controls'
import { useChat } from '../../store/chatStore'
import { desktop } from '../../services/desktop'
import { contextDefaults } from '../../../shared/context'
import type { AgentMode } from '../../../shared/agent'
import { CustomSelect } from '../../components/ui/CustomSelect'

export function ProjectAccessSettings() {
  const { snapshot, command, pending, issue } = useChat()
  const project = snapshot.workspaces?.[0], id = snapshot.sessionId
  const [root, setRoot] = useState('')
  const limits = snapshot.config?.contextSettings ?? contextDefaults()
  const mode = snapshot.config?.agentMode ?? 'ask'
  useEffect(() => {
    let current = true; setRoot('')
    if (id && project?.authorized) void desktop.chatContext({ action: 'project-status', sessionId: id, id: project.id }).then((result) => { if (current) setRoot(result.root ?? result.message ?? '') }).catch(() => { if (current) setRoot('Could not verify project root.') })
    return () => { current = false }
  }, [id, project?.id, project?.authorized])
  if (!project || !id) return null
  const update = (changes: Partial<{ mode: AgentMode; allowDeletion: boolean; allowCommands: boolean }>) => command({ action: 'project-permissions', id, mode, allowDeletion: limits.allowProjectDeletion, allowCommands: limits.allowProjectCommands, ...changes })
  return <Section title="Project access" description={`Permissions for ${project.name} in this conversation. Changing permissions stops any active task; no grant is transferred to a newly opened project.`}>
    <div className="ai-context-settings">
      <p>Project root: <code style={{ overflowWrap: 'anywhere' }}>{root || 'Not currently authorized'}</code></p>
      <p>Read access: {project.authorized ? 'Authorized' : 'Disconnected — select the folder again'}</p>
      <label className="custom-select-field"><span>Access level</span><CustomSelect ariaLabel="Project access level" value={mode} disabled={pending} options={[{ value: 'read-only', label: 'Read Only' }, { value: 'ask', label: 'Ask Before Changes' }, { value: 'workspace-auto', label: 'Workspace Auto Edit' }, { value: 'advanced', label: 'Advanced Agent' }]} onChange={(value) => { const next = value as AgentMode; void update({ mode: next, ...(next === 'advanced' ? { allowCommands: true } : {}) }) }} /></label>
      <label><input type="checkbox" checked={limits.allowProjectDeletion} disabled={pending} onChange={(event) => void update({ allowDeletion: event.target.checked })} />Allow deletion and moves after confirmation</label>
      <label><input type="checkbox" checked={limits.allowProjectCommands} disabled={pending} onChange={(event) => void update({ allowCommands: event.target.checked })} />Allow development commands{mode === 'advanced' ? ' (isolated offline commands run without prompts)' : ' after confirmation'}</label>
      <p>Read Only blocks mutations and commands. Ask Before Changes previews each edit and command. Workspace Auto Edit permits ordinary edits; commands still ask. Advanced Agent also preauthorizes isolated offline development commands and larger ordinary edit batches in this workspace. Deletions, sensitive files, network access, dependency installation, Git writes and separate macOS permissions still require approval.</p>
      <p>Cursor’s native adapter keeps terminal/network actions blocked. Disabling deletion makes its session read-only because its file-operation notifications cannot reliably distinguish deletion from replacement.</p>
      {issue && <p role="alert">{issue}</p>}
    </div>
  </Section>
}
