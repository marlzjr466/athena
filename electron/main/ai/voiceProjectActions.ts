import { mkdir, realpath, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { effortSchema } from '../../../shared/conversations'
import type { UnifiedAccountCatalog } from '../../../shared/unifiedAccounts'
import { resolveReasoningEfforts } from '../../../shared/modelCapabilities'
import { z } from 'zod'
import type { NativeActionMetadata } from './nativeActionRegistry'
import { nativeActionResultSchema } from './nativeActionRegistry'
import { ChatError } from './AIProvider'
import type { ChatController } from './chatController'
import type { ChatContextService } from './chatContextService'

const empty = z.object({}).strict()
const query = z.object({ query: z.string().trim().max(160) }).strict()
const branch = z.object({ branch: z.string().trim().min(1).max(255) }).strict()
const folder = z.object({ name: z.string().trim().min(1).max(100).refine(value => !/[\\/:*?"<>|\x00-\x1f]/.test(value) && !/^\.|[. ]$/.test(value) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value), 'Use one ordinary folder name, without path separators.') }).strict()

/** Additional actions registered in NativeActionRegistry; all execution stays in existing services. */
export function voiceProjectActions(services: {
  chat: ChatController; context: ChatContextService
  catalog?: () => Promise<UnifiedAccountCatalog>
  provider?: () => string
  pickFolder(createName?: string): Promise<string | undefined>
  reveal(folder: string): Promise<void>
  location?():Promise<string|undefined>
  showConversation(): void
}): NativeActionMetadata[] {
  const { chat, context } = services
  const selected = () => {
    const session = chat.getSession(chat.selectedSessionId())
    if (!session) throw new ChatError('Select a conversation first.')
    return session
  }
  const project = async () => {
    const session = selected(), workspace = session.workspaces[0]
    if (!workspace) throw new ChatError('This conversation has no project. Ask to open a project first.')
    const root = await context.workspaces.authorizedRoot(workspace.id)
    if (chat.selectedSessionId() !== session.id) throw new ChatError('The active conversation changed. No action was run.')
    return { sessionId: session.id, workspaceId: workspace.id, root, name: workspace.name }
  }
  const make = (id: string, toolName: string, description: string, inputSchema: z.ZodType, permission: NativeActionMetadata['requiredPermission'], run: NonNullable<NativeActionMetadata['run']>, extra: Partial<NativeActionMetadata> = {}): NativeActionMetadata => ({ id, toolName, description, inputSchema, requiredPermission: permission, confirmation: 'explicit-user-command', cancellable: true, resultSchema: nativeActionResultSchema, run, ...extra })
  const read = { confirmation: 'none' as const, repeatable: true }
  const resolveSession = (value: string) => {
    const sessions = chat.snapshot().sessions ?? [], term = value.toLocaleLowerCase().trim()
    if (['active', 'current', 'this', 'my active', 'my current'].includes(term)) return selected()
    let matches = term === 'previous' ? sessions.filter(item => item.id !== selected().id).slice(0,1)
      : ['latest','last'].includes(term) ? sessions.slice(0, 1)
      : ['normal', 'non-project', 'regular'].includes(term) ? sessions.filter(item => !item.project).slice(0, 1)
      : sessions.some(item => item.title.toLocaleLowerCase() === term) ? sessions.filter(item => item.title.toLocaleLowerCase() === term)
      : sessions.filter(item => item.title.toLocaleLowerCase().includes(term))
    if (!matches.length && term.length >= 3) {
      matches = sessions.filter(item => chat.getSession(item.id)?.messages.some(message =>
        (message.role === 'user' || message.role === 'assistant') && message.content.toLocaleLowerCase().includes(term)))
    }
    if (matches.length !== 1) throw new ChatError(matches.length ? 'Several conversations match. Say the full, unique conversation title.' : 'No matching conversation exists. Say its title or ask to create a new chat.')
    return chat.getSession(matches[0].id)!
  }
  const git = (action: 'status' | 'branches' | 'switch' | 'create'): NonNullable<NativeActionMetadata['run']> => async (input, _options, signal, revalidate) => {
    const target = await project()
    const before = await context.git.run({ action: 'status', sessionId: target.sessionId, workspaceId: target.workspaceId }, 'voice', () => {})
    signal.throwIfAborted()
    if (!before.ok || !before.state?.repository) throw new ChatError(before.message ?? 'This project is not a Git repository.')
    if (before.state.error) throw new ChatError(before.state.error)
    if (action === 'status') return { ok: true, data: before.state, message: `${before.state.branch ? `Current branch: ${before.state.branch}` : `Detached HEAD: ${before.state.detached}`}. ${before.state.changedFiles ?? 'Unknown number of'} changed files.` }
    if (action === 'branches') {
      const branches = before.state.branches.filter(name => name.toLocaleLowerCase().includes(String(input.query ?? '').toLocaleLowerCase()))
      return { ok: true, data: branches, message: branches.length ? `${branches.length} local branches. ${branches.slice(0, 8).join(', ')}${branches.length > 8 ? '. See the branch selector for the full list.' : '.'}` : 'No local branches match.' }
    }
    await revalidate()
    if (chat.selectedSessionId() !== target.sessionId) throw new ChatError('The conversation changed before the branch operation.')
    const result = await context.git.run({ action, sessionId: target.sessionId, workspaceId: target.workspaceId, branch: input.branch, expectedHead: before.state.head }, 'voice', () => {})
    if (!result.ok) throw new ChatError(result.message ?? 'Git refused the branch change. Local changes were preserved.')
    if (!result.state || result.state.branch !== input.branch) throw new ChatError('The branch operation was attempted, but the expected branch could not be verified. Inspect the branch selector before retrying.')
    return { ok: true, verified: true, data: result.state, message: `${action === 'create' ? 'Created and switched to' : 'Switched to'} ${result.state.branch}. Local changes were preserved.` }
  }
  const choice = z.object({sessionId:z.string().uuid(), model:z.string().trim().min(1).max(200), provider:z.string().trim().min(1).max(100).optional(), effort:effortSchema.optional()}).strict()
  const configure: NonNullable<NativeActionMetadata['run']> = async (input, options, signal, revalidate) => {
    const target = selected(), route = target.config.accountRoute
    if (input.sessionId !== target.id) throw new ChatError('The conversation changed. Select it again.')
    const effort = effortSchema.optional().parse(input.effort)
    if (!services.catalog) throw new ChatError('The connected model catalog is unavailable.')
    const requested = String(input.model ?? target.config.model ?? '')
    const normalize = (s:string) => s.toLowerCase().replace(/[-_\s]+/g, '')
    if (input.model && !normalize(options.userText).includes(normalize(requested))) throw new ChatError('Name the model you want to select.')
    const {accounts} = await services.catalog()
    await revalidate(); signal.throwIfAborted()
    if (selected().id !== target.id || target.config.accountRoute !== route) throw new ChatError('Conversation selection changed while checking models.')
    const provider = typeof input.provider === 'string' ? normalize(input.provider) : undefined
    if (provider && !normalize(options.userText).includes(provider)) throw new ChatError('Name the provider or account before switching.')
    const names:Record<string,string[]>={subscription:['ChatGPT','ChatGPT Subscription'],cloud:['OpenAI API'],copilot:['GitHub Copilot'],'claude-api':['Claude API'],'third-party':['Third Party Inference'],antigravity:['Google Antigravity']}
    const matches = accounts.filter(a => a.enabled && ['connected','limited'].includes(a.state) && (provider ? [a.name,a.route.provider,...(names[a.route.provider] ?? [])].some(n=>normalize(n)===provider) : a.route.provider === (route?.provider ?? services.provider?.()) && (!route || a.route.accountId === route.accountId)))
      .flatMap(account => account.models.filter(model => model.available && [model.label,model.id,...(model.aliases ?? []),...Object.values(model.effortModelIds ?? {})].some(s => normalize(s) === normalize(requested))).map(model => ({account,model})))
    if (matches.length !== 1) throw new ChatError(matches.length ? 'Several models match. Choose the account in the conversation first.' : 'That model is unavailable on the current account. Check the conversation model selector.')
    const {account,model} = matches[0]
    if (effort && effort !== 'auto' && !(model.efforts ?? resolveReasoningEfforts(account.route.provider,model.id) ?? []).includes(effort)) throw new ChatError('This model does not support that reasoning effort.')
    const variant = effort && account.route.provider === 'cursor' ? model.effortModelIds?.[effort] ?? model.fastModelIds?.[effort]?.disabled : undefined
    const id = variant ?? model.id
    const changed = chat.command({action:'select-account-model', id:target.id, route:account.route, model:id})
    if (!changed.ok || selected().config.model !== id) throw new ChatError(changed.message ?? 'Could not verify the model selection.')
    if (effort && !variant) {
      const changedEffort = chat.command({action:'configure-effort',id:target.id,effort})
      if (!changedEffort.ok || selected().config.effort !== effort) throw new ChatError('The model was selected, but its reasoning effort could not be set.')
    }
    return {ok:true, verified:true, sessionId:target.id, message:`Selected ${model.label}${effort ? ' with ' + effort + ' reasoning' : ''}.`}
  }
  return [
    make('athena.chat.chooseModel','athena_chat_choose_model','Select a uniquely named available model on the current account.',choice,'conversationManagement',configure,{intent:(text,input)=>/\b(?:use|select|switch)\b/i.test(text) && (!input.effort || text.toLowerCase().includes(String(input.effort)))}),
    make('athena.chat.changeEffort','athena_chat_change_effort','Change the reasoning effort on the active conversation model.',choice.omit({model:true,provider:true}).required(),'conversationManagement',configure,{intent:(text,input)=>/\b(?:set|use|change)\b/i.test(text) && text.toLowerCase().includes(String(input.effort))}),
    make('athena.navigation.location','athena_navigation_location','Report the current Athena page.',empty,'internalNavigation',async()=>{
      const page=await services.location?.()
      if(!page)throw new ChatError('The main window has no active page.')
      return {ok:true,message:'Athena is on '+page.replaceAll('-',' ')+'.'}
    },read),
    make('athena.chat.target','athena_chat_target','Identify the active project, selected model, processing state and presence of a draft.',empty,'conversationManagement',async()=>{
      const session=selected(),view=chat.snapshot(),hasDraft=Boolean(view.draft?.trim())
      return {ok:true,sessionId:session.id,data:{hasDraft,phase:view.phase},
        message:`${session.workspaces[0]?.name ?? 'No project'}. The model is ${session.config.model ?? 'the provider default'} with ${session.config.effort} reasoning. The chat is ${view.phase}.${hasDraft?' There is an unsent draft.':''}`}
    },read),
    make('athena.chat.recap', 'athena_chat_recap', 'Give a local recap of the active chat on explicit request.', empty, 'conversationManagement', async () => {
      const messages = selected().messages
      const requests = messages.filter(m => m.role === 'user')
      const replies = messages.filter(m => m.role === 'assistant' && m.status === 'complete' && m.content.trim())
      const excerpt = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0,260)
      return {ok:true, message: [
        `This conversation has ${requests.length} user messages and ${replies.length} completed replies.`,
        requests.length && 'Latest request: ' + excerpt(requests.at(-1)!.content),
        replies.length && 'Latest reply: ' + excerpt(replies.at(-1)!.content),
      ].filter(Boolean).join(' ')}
    }, {...read, intent: text => /\b(?:summarize|recap)\b/i.test(text) && /\b(?:chat|conversation|session)\b/i.test(text)}),
    make('athena.chat.readResponse','athena_chat_read_response','Read an excerpt of the last completed assistant response only on explicit request.',empty,'conversationManagement',async()=>{
      const reply=selected().messages.findLast(m=>m.role==='assistant' && m.status==='complete' && m.content.trim())
      if(!reply) throw new ChatError('This chat has no completed assistant response to read.')
      return {ok:true,message:reply.content.length>780 ? reply.content.slice(0,780)+'… The rest is in the conversation.' : reply.content}
    },{...read,intent:text=>/^(?:(?:hey )?athena[, ]+)?(?:please )?(?:read|repeat) (?:me )?(?:the |my )?(?:latest|last) (?:assistant )?(?:response|reply|answer)(?: to me| aloud)?[.!?]?$/i.test(text.trim())}),
    make('athena.project.conversations','athena_project_conversations','List conversations in the active project.',empty,'projectManagement',async()=>{
      const target=await project();const names=(chat.snapshot().sessions??[]).filter(s=>s.project?.id===target.workspaceId).map(s=>s.title)
      return {ok:true,message:names.slice(0,8).join(', ')||'No conversations in this project.'}
    },{...read,additionalPermissions:['conversationManagement']}),
    make('athena.chat.resolveSession', 'athena_chat_resolve_session', 'Resolve active/current/latest/normal or a unique existing conversation title. Never guess among ambiguous matches.', query, 'conversationManagement', async input => ({ ok: true, sessionId: resolveSession(String(input.query)).id }), read),
    make('athena.chat.findSessions', 'athena_chat_find_sessions', 'Find saved conversations by title. Empty query lists recent conversations.', query, 'conversationManagement', async input => {
      const sessions = (chat.snapshot().sessions ?? []).filter(item => item.title.toLocaleLowerCase().includes(String(input.query).toLocaleLowerCase()))
      return { ok: true, sessions: sessions.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })), message: sessions.length ? `${sessions.length} conversations. ${sessions.slice(0, 6).map(item => item.title).join('; ')}.` : 'No matching conversations.' }
    }, read),
    make('athena.chat.taskStatus', 'athena_chat_task_status', 'Read the active conversation task status without reading its response aloud.', empty, 'conversationManagement', async () => ({ ok: true, message: `The active conversation is ${chat.snapshot().phase}.`, sessionId: selected().id }), read),
    make('athena.project.list', 'athena_project_list', 'List recent projects from existing conversations. Stored names do not grant file access.', empty, 'projectManagement', async () => {
      const projects = [...new Map((chat.snapshot().sessions ?? []).filter(item => item.project).map(item => [item.project!.id, { name: item.project!.name, sessionId: item.id }])).values()]
      return { ok: true, data: projects, message: projects.length ? `Recent projects: ${projects.slice(0, 8).map(item => item.name).join(', ')}.` : 'No recent projects. Ask to open another project to choose a folder.' }
    }, read),
    make('athena.project.open', 'athena_project_open', 'Open a unique existing project by name, current, or last. Unknown folders require the native picker; names never grant access.', query, 'projectManagement', async (input, _options, signal, revalidate) => {
      const term = String(input.query).toLocaleLowerCase()
      const sessions = (chat.snapshot().sessions ?? []).filter(item => item.project)
      const matches = ['last', 'latest'].includes(term) ? sessions.slice(0, 1) : ['current', 'this', 'active'].includes(term) ? sessions.filter(item => item.id === selected().id) : sessions.filter(item => item.project!.name.toLocaleLowerCase() === term)
      const projects = [...new Map(matches.map(item => [item.project!.id, item])).values()]
      if (projects.length !== 1) throw new ChatError(projects.length ? 'More than one project has that name. Select the exact folder with “open another project”.' : 'That project is not known. Say “open another project” and choose its folder to authorize access.')
      await context.workspaces.authorizedRoot(projects[0].project!.id)
      await revalidate(); signal.throwIfAborted()
      if(selected().workspaces.some(w=>w.id===projects[0].project!.id)) {
        services.showConversation()
        return {ok:true,sessionId:selected().id,message:'This conversation is already in '+projects[0].project!.name+'.'}
      }
      const result = chat.command({ action: 'switch', id: projects[0].id })
      if (!result.ok || chat.selectedSessionId() !== projects[0].id) throw new ChatError(result.message ?? 'Could not verify the selected project.')
      services.showConversation()
      return { ok: true, sessionId: projects[0].id, message: `Opened project ${projects[0].project!.name}.` }
    }, { intent: text => /\b(?:open|switch|use)\b/i.test(text), additionalPermissions: ['conversationManagement'] }),
    ...(['choose', 'create'] as const).map(action => make(`athena.project.${action}`, `athena_project_${action}`, action === 'choose' ? 'Ask the user to choose a project with the native folder picker. A cancelled picker is not a successful project change.' : 'Create one new folder beneath a parent the user selects in a native picker. Never reuse an existing directory or grant access to the parent.', action === 'choose' ? empty : folder, 'projectManagement', async (input, _options, signal, revalidate) => {
      const original = selected().id
      const chosen = await services.pickFolder(action === 'create' ? String(input.name) : undefined)
      await revalidate()
      if (!chosen) throw new ChatError('Folder selection was cancelled. No project was changed.')
      if (chat.selectedSessionId() !== original) throw new ChatError('The conversation changed while the folder picker was open.')
      const parent = await realpath(chosen), identity = await lstat(parent)
      if (!identity.isDirectory() || identity.isSymbolicLink()) throw new ChatError('Choose an accessible directory.')
      let root = parent
      if (action === 'create') {
        root = join(parent, String(input.name))
        const current = await lstat(chosen)
        if (await realpath(chosen) !== parent || current.ino !== identity.ino || current.dev !== identity.dev) throw new ChatError('The selected parent directory changed. Choose it again.')
        await revalidate(); signal.throwIfAborted()
        try { await mkdir(root, { mode: 0o700 }) } catch (error) { throw new ChatError((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'That folder already exists. Ask to open it instead.' : 'The project folder could not be created. Check filesystem permissions.') }
      }
      await revalidate()
      const workspace = await context.workspaces.connect(root, chat.workspaceReferences())
      signal.throwIfAborted()
      chat.openWorkspace(workspace, [])
      if (selected().workspaces[0]?.id !== workspace.id) throw new ChatError('The selected project could not be verified.')
      services.showConversation()
      return { ok: true, sessionId: selected().id, message: `${action === 'create' ? 'Created and opened' : 'Opened'} project ${workspace.name}. Its conversation permission mode still applies.` }
    }, { additionalPermissions: ['conversationManagement', ...(action === 'create' ? ['fileModification' as const] : [])], requiredOSPermission: 'personalFiles', intent: text => /\b(?:project|folder|directory)\b/i.test(text) && (action === 'create' ? /\b(?:create|make)\b/i.test(text) : /\b(?:open|select|choose)\b/i.test(text)) })),
    make('athena.project.openEditor', 'athena_project_open_editor', 'Open the current authorized conversation project folder in installed VS Code. Does not execute project commands.', empty, 'projectManagement', async (_input, _options, signal, revalidate) => {
      const target = await project(); await revalidate(); signal.throwIfAborted()
      const result = await context.editor.run({ action: 'open', sessionId: target.sessionId, workspaceId: target.workspaceId })
      if (!result.ok) throw new ChatError(result.message ?? 'VS Code could not open this project.')
      return { ok: true, message: 'VS Code accepted the authorized project folder. The editor contents were not inspected.' }
    }, { additionalPermissions: ['desktopApplicationControl'], intent: text => /\b(?:open|show)\b/i.test(text) && /\b(?:VS\s*Code|Visual Studio Code)\b/i.test(text) }),
    make('athena.project.reveal', 'athena_project_reveal', 'Reveal the active authorized project folder in Finder or Windows Explorer.', empty, 'projectManagement', async (_input, _options, signal, revalidate) => {
      const target = await project(); await revalidate(); signal.throwIfAborted()
      await services.reveal(target.root)
      return { ok: true, message: 'The file manager accepted the project folder. Its window contents were not inspected.' }
    }, { additionalPermissions: ['desktopApplicationControl'], intent: text => /\b(?:reveal|show|open)\b/i.test(text) }),
    make('athena.git.status', 'athena_git_status', 'Read the current branch and staged, unstaged and untracked changed-file count for the active project.', empty, 'gitOperations', git('status'), { ...read, additionalPermissions: ['fileReading'] }),
    make('athena.git.branches', 'athena_git_branches', 'List or search local Git branches in the active project. Empty query lists all.', query, 'gitOperations', git('branches'), { ...read, additionalPermissions: ['fileReading'] }),
    ...(['switch', 'create'] as const).map(action => make(`athena.git.${action}`, `athena_git_${action}`, `Explicitly ${action} a local branch using Git’s safeguards, verify HEAD, and refresh project context. Never stash, force, reset, discard, commit or push. Active coding tasks block changes.`, branch, 'gitOperations', git(action), { additionalPermissions: ['fileModification'], intent: (text, input) => (action === 'create' ? /\b(?:create|make)\b/i : /\b(?:switch|change|checkout)\b/i).test(text) && text.includes(String(input.branch)) })),
  ]
}
