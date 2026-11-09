import type { Settings } from '../../../shared/settings'
import { APPLICATIONS } from '../../../shared/desktopActions'
import type { SpeechIdentity } from '../../../shared/speech'
import { isLocalOwnership, type AIOwnership } from '../../../shared/aiOwnership'

export interface ActionSpeechEvent extends SpeechIdentity { tool: string; input: unknown; signal: AbortSignal; ownership?: AIOwnership }
export interface Announcement extends SpeechIdentity { text: string; signal?: AbortSignal; waitForStart: boolean }
export interface AnnouncementResult { started: boolean }

// Intent comes from the validated tool, never from repository prose or a second
// AI request. These phrases describe attempts, not successful outcomes.
export function actionDescription(tool: string, input: unknown): string | undefined {
  const app = input && typeof input === 'object' && 'app' in input && typeof input.app === 'string'
    ? APPLICATIONS[input.app as keyof typeof APPLICATIONS]?.name : undefined
  if (tool === 'open_application' && app) return `I'm opening ${app} now.`
  if (tool === 'focus_application' && app) return `I'll switch to ${app}.`
  if (tool === 'open_project_in_vscode') return "I'll open your project in VS Code."
  if (tool === 'open_url') return "I'll open that address in your browser."
  if (/^(run_tests|run_typecheck|run_linter|run_build)$/.test(tool)) return ({ run_tests: "I'll run the tests.", run_typecheck: "I'll check the types.", run_linter: "I'll run the linter.", run_build: "I'll run the build." })[tool]
  if (/^(search_|find_)/.test(tool)) return "Let me find that in your project."
  if (/^(read_file|open_file|inspect_|list_directory|get_file_metadata|get_project_structure|analyze_project|retrieve_relevant_context|list_approved_files)/.test(tool)) return "Let me take a look."
  if (/^(create_|write_file|edit_file|apply_patch|rename_file|move_file)/.test(tool)) return "I'll make the approved changes."
  if (/^(delete_|revert_change)/.test(tool)) return "I'll carry out the change you approved."
  if (tool === 'execute_command' || tool.startsWith('git_')) return "I'll run that project operation."
  if (/^(capture_screen|read_screen)$/.test(tool)) return "I'll take a look at the screen you approved."
  if (/^get_(active_app|running_apps)$/.test(tool)) return "Let me check your applications."
  return undefined
}

export class ActionNarrator {
  private task?: { id: string; lastAt: number; acknowledged: boolean; categories: Set<string>; initialSpeech?: Promise<AnnouncementResult> }
  private previousPrefix = -1
  constructor(private settings: () => Settings, private announce: (request: Announcement) => Promise<AnnouncementResult>, private random = Math.random) {}
  async beforeAction(event: ActionSpeechEvent): Promise<string | undefined> {
    if (!isLocalOwnership(event.ownership) || event.ownership.sessionId !== event.sessionId || event.ownership.correlationId !== event.messageId) return
    const settings = this.settings(), voice = settings.localVoice
    if (!settings.voiceEnabled || settings.voiceMuted || settings.doNotDisturb || !voice.autoSpeak || event.signal.aborted) return
    const description = actionDescription(event.tool, event.input)
    if (!description) return
    if (this.task?.id !== event.messageId) this.task = { id: event.messageId, lastAt: Date.now(), acknowledged: false, categories: new Set() }
    const task = this.task
    if (task.initialSpeech) { await task.initialSpeech; if (event.signal.aborted) return }
    const first = !task.acknowledged
    const category = event.tool.replace(/^(read_file|inspect_.*|list_directory|get_.*|analyze_project)$/, 'inspect').replace(/^(search_.*|find_.*)$/, 'search')
    if (!first && (!voice.spokenProgress || Date.now() - task.lastAt < voice.progressIntervalSeconds * 1000 || task.categories.has(category))) return
    task.acknowledged = true
    if (first && !voice.naturalAcknowledgments) return
    task.lastAt = Date.now(); task.categories.add(category)
    const prefixes = ['Sure.', 'Alright.', 'Okay.', 'Of course.', 'Yep.', 'Sure thing.']
    const choices = prefixes.map((_, index) => index).filter((index) => index !== this.previousPrefix)
    this.previousPrefix = choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))]
    const text = `${prefixes[this.previousPrefix]} ${description}`
    const speech = this.announce({ ...event, text, waitForStart: first && voice.speakBeforeActions })
    if (!first || !voice.speakBeforeActions) { void speech.catch(() => {}); return }
    task.initialSpeech = speech.catch(() => ({ started: false }))
    const result = await task.initialSpeech
    task.initialSpeech = undefined
    return result.started ? text : undefined
  }
}
