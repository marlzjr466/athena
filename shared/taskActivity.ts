import type { TaskVisualMode } from './contracts'
import type { ChatSnapshot } from './chat'

export function currentTaskActivity(snapshot: ChatSnapshot) {
  const reply = snapshot.messages.at(-1)
  const activities = reply?.role === 'assistant' && reply.status === 'streaming' ? reply.execution?.activities ?? [] : []
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i]
    if (activity.status === 'running') return { mode: taskVisualModeForActivity(activity.tool, activity.label), type: activity.tool, label: activity.label }
  }
  return { mode: snapshot.phase === 'speaking' ? 'typing' as const : 'thinking' as const, type: 'assistant', label: snapshot.phase === 'speaking' ? 'Writing a response' : 'Considering your request' }
}

export function taskScreenTitle(mode: TaskVisualMode, tool = '') {
  if (mode === 'typing') {
    if (/delete|remove/.test(tool)) return 'Delete'
    if (/create/.test(tool)) return 'Create'
    return tool === 'assistant' ? 'Response' : 'Edit'
  }
  if (mode === 'terminal' && /test|build|lint|typecheck/.test(tool)) return /build/.test(tool) ? 'Build' : 'Verify'
  if (mode === 'browser' && /verify|test|check/.test(tool)) return 'Verify'
  return ({ terminal: 'Terminal', searching: 'Search', reading: 'Read', exploring: 'Explore', browser: 'Browser', thinking: 'Working', completed: 'Complete', failed: 'Needs attention', cancelled: 'Cancelled', idle: '' })[mode]
}

export function taskVisualModeForActivity(tool: string, label: string): TaskVisualMode {
  const toolName = tool.toLowerCase()
  const description = label.toLowerCase()
  if (/browser|verify|open_url|open_web/.test(toolName)) return 'browser'
  if (/terminal|execute_command|run_tests|run_build|run_linter|typecheck|git_|dev_server/.test(toolName)) return 'terminal'
  if (/search|grep|find/.test(toolName)) return 'searching'
  if (/read_file|readfile|review_change/.test(toolName)) return 'reading'
  if (/explore|list_|project_structure|analyze_project|get_file_metadata/.test(toolName)) return 'exploring'
  if (/delete|remove|edit|write|patch|create|move|rename|revert_change/.test(toolName)) return 'typing'
  if (/browser|verify|website|page/.test(description)) return 'browser'
  if (/terminal|running command|test|build|typecheck/.test(description)) return 'terminal'
  if (/search|find|looking up/.test(description)) return 'searching'
  if (/read|reading|open file/.test(description)) return 'reading'
  if (/explore|inspect|project structure/.test(description)) return 'exploring'
  if (/delete|remove|edit|write|patch|create|move|rename/.test(description)) return 'typing'
  return 'thinking'
}

export function taskVisualModeForStatus(status: string): TaskVisualMode {
  if (status === 'complete' || status === 'completed') return 'completed'
  if (status === 'cancelled' || status === 'stopped') return 'cancelled'
  if (status === 'error' || status === 'failed' || status === 'interrupted') return 'failed'
  return 'thinking'
}
