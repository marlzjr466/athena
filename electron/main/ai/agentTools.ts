import { sandboxCommandScope } from '../permissions/sandboxCommandPermission'
import type { RememberedScope } from '../../../shared/permissions'
import { z } from 'zod'
import { homedir } from 'node:os'
import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentMode, ChangePreview } from '../../../shared/agent'
import type { SourceReference } from '../../../shared/conversations'
import { ChatError, type ProjectTools } from './AIProvider'
import type { ChatController } from './chatController'
import { AgentEdits, versionOf, type EditProposal } from './agentEdits'
import { checkSourceSyntax, requireValidSource } from './sourceSyntax'
import { AgentCommands, type CommandRequest } from './agentCommands'
import { validateCommandReadPaths } from './commandFileAccess'
import { DevelopmentServerService } from './developmentServer'
import { LocalBrowserVerificationService, type BrowserViewport } from './localBrowserVerification'
import { assertStagedCommitUnchanged, inspectStagedCommit } from './gitCommitReview'
import { GitIdentityService, type GitIdentity } from './gitIdentity'
import { createProjectTools } from './projectTools'
import { FULL_MAC_WORKSPACE_ID, sensitiveContent, sensitivePath, type WorkspaceService } from './workspaceService'
import { contextDefaults, type ContextSettings } from '../../../shared/context'
import { limitToolOutput, summarizeLog } from './toolOutput'
import { log } from '../logger'
import { FilesystemAccessError, filesystemToolError } from './filesystemErrors'

const path = z.string().min(1).max(1000), version = z.string().regex(/^[a-f0-9]{64}$/), content = z.string().max(100_000)
const sensitiveConfiguration = (value: string) => value.split(/[\\/]/).some((part) => part.startsWith('.') && !['.', '..', '.tmp'].includes(part)) || /(?:^|\/)(?:Library\/(?:Preferences|Application Support)|private\/etc|etc)(?:\/|$)/i.test(value)
const change = z.object({ path, expected_version: version.nullable(), content: content.nullable() }).strict()
const definitions = [
  { name: 'list_changes', description: 'List this conversation’s local recovery records and change IDs. No other session’s changes are accessible.', schema: z.object({}).strict() },
  { name: 'review_change', description: 'Read the original/resulting diff of a specific recovery record in this conversation.', schema: z.object({ id: z.string().uuid() }).strict() },
  { name: 'revert_change', description: 'Restore a recorded file change after confirmation. Refuses to overwrite newer user changes.', schema: z.object({ id: z.string().uuid() }).strict() },
  { name: 'create_file', description: 'Create an ordinary UTF-8 source file. Parent directory must exist. Never overwrites an existing file.', schema: z.object({ path, content }).strict() },
  { name: 'write_file', description: 'Replace a source file using the exact SHA-256 version returned by read_file. Prefer edit_file for targeted changes.', schema: z.object({ path, expected_version: version, content }).strict() },
  { name: 'edit_file', description: 'Replace one exact, unique code section. Read the file first and provide its version. old_text/new_text contain literal file text, NOT the numbered display prefixes from read_file. Include enough surrounding lines to identify one match; preserve whitespace and line endings. Ambiguous matches are rejected.', schema: z.object({ path, expected_version: version, old_text: content.min(1), new_text: content }).strict() },
  { name: 'apply_patch', description: 'Apply a version-checked batch of 1–20 files. Each content is the complete resulting file (null deletes); expected_version null means new file. Every target is preflighted before applying. Deletes always require approval.', schema: z.object({ changes: z.array(change).min(1).max(20) }).strict() },
  { name: 'delete_file', description: 'Delete a previously read source file with confirmation and recoverable backup. Never recursively deletes directories.', schema: z.object({ path, expected_version: version }).strict() },
  { name: 'rename_file', description: 'Rename a source file without overwriting the destination. References are NOT automatically changed: search and edit those explicitly.', schema: z.object({ path, destination: path, expected_version: version }).strict() },
  { name: 'move_file', description: 'Move a source file inside the workspace; destination must be absent. Update imports explicitly as separate edits.', schema: z.object({ path, destination: path, expected_version: version }).strict() },
  { name: 'create_directory', description: 'Create one new ordinary directory. Create missing parents explicitly.', schema: z.object({ path }).strict() },
  { name: 'delete_directory', description: 'Delete an ordinary directory with confirmation. Empty only by default; recursive=true previews every entry and moves the tree into private recovery storage. Protected, ignored, symlinked, binary or oversized trees are rejected.', schema: z.object({ path, recursive: z.boolean().optional() }).strict() },
  ...(['rename_directory', 'move_directory'] as const).map(name => ({ name, description: 'Move or rename an ordinary directory within this workspace after preview and explicit confirmation. Destination must be absent. Preserves contents and supports recovery; changed or protected trees are rejected.', schema: z.object({ path, destination: path }).strict() })),
  { name: 'execute_command', description: 'Run an approved executable with an argument array (no shell string) in an approved workspace directory. local_network grants outbound loopback only after approval; network separately grants external access. working_directory may be an accessible absolute directory only when Full Mac Access is active. read_paths requests user-approved read access to exact credential-named files inside the working directory. Source writes are blocked; use file tools.', schema: z.object({ executable: z.enum(['echo', 'npm', 'pnpm', 'yarn', 'node', 'python3', 'go', 'cargo', 'curl']), args: z.array(z.string().max(1000)).max(40), network: z.boolean(), local_network: z.boolean().optional(), install_dependencies: z.boolean(), working_directory: path.optional(), read_paths: z.array(path).max(20).optional() }).strict() },
  { name: 'start_dev_server', description: 'Run the external project’s declared package.json script (including dev:mock) unchanged. Returns a stable server id for verification. HOST/PORT are hints; provide readiness_url for fixed-port or multiple-server scripts. script_args are passed only when explicitly supplied. restart replaces only this owned project server after waiting for exit; never restarts Athena.', schema: z.object({ script: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/).optional(), working_directory: path.optional(), server_id: z.string().uuid().optional(), restart: z.boolean().optional(), readiness_url: z.string().max(1500).optional(), script_args: z.array(z.string().max(500)).max(20).optional() }).strict() },
  { name: 'stop_dev_server', description: 'Stop only the external project server owned by this conversation and project, and wait for exit. Use server_id when more than one exists.', schema: z.object({ server_id: z.string().uuid().optional() }).strict() },
  { name: 'verify_local_app', description: 'Inspect the server_id returned by start_dev_server in a separate temporary browser process. Requires Local Browser Verification permission. A missing handle blocks verification without restarting Athena. Only the managed loopback origin is accessible.', schema: z.object({ server_id: z.string().uuid().optional(), path: z.string().min(1).max(1500).default('/'), viewport: z.enum(['desktop', 'mobile']).default('desktop'), selectors: z.array(z.string().min(1).max(250)).max(10).default([]) }).strict() },
  ...(['run_tests', 'run_linter', 'run_typecheck', 'run_build'] as const).map((name) => ({ name, description: 'Run the existing matching package.json script using the project lockfile package manager. local_network optionally requests approved outbound loopback access; external internet remains blocked.', schema: z.object({ local_network: z.boolean().optional() }).strict() })),
  { name: 'inspect_dependencies', description: 'Read package.json dependency and script declarations. Reports actual source, not installed-package assumptions.', schema: z.object({}).strict() },
  { name: 'inspect_errors', description: 'Return actual diagnostics from the most recent command in this request.', schema: z.object({}).strict() },
  { name: 'get_git_identity', description: 'Read the effective user.name and user.email for this repository using the user’s actual global Git configuration. Returns each value, local/global scope, or a distinct missing/permission/tool error. Read-only: never sets Git configuration. Use this for /platform-init; isolated terminal commands intentionally hide global Git config.', schema: z.object({}).strict() },
  ...(['git_status', 'git_diff', 'git_log'] as const).map((name) => ({ name, description: 'Run the named read-only Git inspection inside the project sandbox, with external diff and user/global config disabled.', schema: z.object({}).strict() })),
  { name: 'git_staged_diff', description: 'Inspect the staged diff for allowed project source files only. Does not stage, commit, or change files.', schema: z.object({}).strict() },
  { name: 'git_conflicts', description: 'List unresolved merge-conflict paths without editing or resolving them.', schema: z.object({}).strict() },
  { name: 'git_reflog', description: 'Inspect the last ten local reflog references and commit IDs without modifying history.', schema: z.object({}).strict() },
  { name: 'git_stash_list', description: 'List local stash references and commit IDs without applying or dropping them.', schema: z.object({}).strict() },
  { name: 'git_show_commit', description: 'Inspect metadata for one full local SHA-1 or SHA-256 commit ID; abbreviated IDs and Git revision expressions are rejected.', schema: z.object({ commit: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/) }).strict() },
  { name: 'git_repository_root', description: 'Run git rev-parse --show-toplevel in the selected project through the isolated Git command runner.', schema: z.object({}).strict() },
  { name: 'git_remotes', description: 'Run git remote -v in the selected project. Credential-bearing URL components are redacted.', schema: z.object({}).strict() },
  { name: 'git_remote_ref', description: 'Resolve origin/<branch> in the selected project with git rev-parse. This reads the local remote-tracking ref; fetch first when a current remote SHA is required.', schema: z.object({ branch: z.string().min(1).max(100) }).strict() },
  { name: 'git_fetch_branch', description: 'Fetch only the named branch from origin into the selected project. Requires separate network and Git-write approval; never changes the working branch or source files.', schema: z.object({ branch: z.string().min(1).max(100) }).strict() },
  { name: 'git_branch', description: 'List branches, or create a new branch after approval. Does not switch branches, delete branches, or rewrite history.', schema: z.object({ create: z.string().max(100).nullable() }).strict() },
  { name: 'git_add', description: 'Stage only listed allowed project source files, with approval. Does not commit.', schema: z.object({ paths: z.array(path).min(1).max(30) }).strict() },
  { name: 'git_commit', description: 'Commit currently staged changes after explicit approval showing every staged diff. Never pushes. Uses the verified local or global Git author identity without changing Git configuration.', schema: z.object({ message: z.string().min(1).max(1000) }).strict() },
  ...(['find_symbol', 'find_references'] as const).map((name) => ({ name, description: 'Text-based whole-symbol search with real file/line references. Results are candidate definitions/usages, not a language-server resolution guarantee.', schema: z.object({ symbol: z.string().min(1).max(150) }).strict() })),
  { name: 'inspect_imports', description: 'Read current source and its import declarations with line numbers; follow relative imports using read_file.', schema: z.object({ path }).strict() },
  { name: 'analyze_project', description: 'Return the actual directory structure and configuration-file candidates. Follow with read_file for architectural evidence.', schema: z.object({}).strict() },
  { name: 'retrieve_relevant_context', description: 'Retrieve bounded source excerpts relevant to a question, with actual path/line evidence. Use additional tools for missing context.', schema: z.object({ question: z.string().min(1).max(1000) }).strict() },
] as const

export class AgentTools {
  readonly edits: AgentEdits
  private commands: AgentCommands
  private developmentServers: DevelopmentServerService
  private browserVerification: LocalBrowserVerificationService
  private browserAutomationAllowed: () => boolean
  constructor(private workspaces: WorkspaceService, storage: string, strictOffline: () => boolean = () => false, private gitIdentity: GitIdentityService = new GitIdentityService(), browserAutomationAllowed: () => boolean = () => false) {
    this.edits = new AgentEdits(workspaces, storage); this.commands = new AgentCommands(strictOffline)
    this.developmentServers = new DevelopmentServerService(this.commands)
    this.browserVerification = new LocalBrowserVerificationService(browserAutomationAllowed)
    this.browserAutomationAllowed = browserAutomationAllowed
  }
  async dispose(): Promise<void> { await Promise.all([this.developmentServers.stopAll(), this.browserVerification.dispose()]) }
  create(chat: Pick<ChatController, 'getSession' | 'approve' | 'beforeAction' | 'activity' | 'finishActivity' | 'stageChanges' | 'updateActivityOutput' | 'updateActivityLabel' | 'changeReverted'>, session: string, workspace: string, name: string, mode: AgentMode, sources: SourceReference[], selected: () => boolean, settings: ContextSettings = contextDefaults(), delegation?: { id: string; localNetwork?: boolean }, boundary?: 'project-only', validateSource = false): ProjectTools {
    const initialAccess = this.workspaces.filesystemMode()
    const commandScope = () => delegation || boundary === 'project-only' ? 'project-only' as const : this.workspaces.filesystemMode()
    const serverOwner = delegation ? `${session}:child:${delegation.id}` : session
    const effectiveMode = initialAccess === 'full-read-only' ? 'read-only' : mode
    // Server lifetime belongs to its owning conversation/project, not the tab
    // currently visible or an individual generation's AbortSignal.
    const serverAuthorized = () => {
      const owner = chat.getSession(session)
      return !!owner && this.workspaces.authorized(workspace)
        && this.workspaces.filesystemMode() === initialAccess
        && (workspace === FULL_MAC_WORKSPACE_ID || owner.workspaces.some((item) => item.id === workspace))
        && (owner.config.contextSettings ?? contextDefaults()).allowProjectCommands
        && owner.config.agentMode !== 'read-only'
    }
    const absoluteTarget = async (value: string) => value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : isAbsolute(value) ? resolve(value) : resolve(await this.workspaces.authorizedRoot(workspace), value)
    const beforeAction = async (tool: string, input: unknown, signal: AbortSignal, alreadyApproved = false) => {
      if (this.workspaces.filesystemMode() !== initialAccess) throw new FilesystemAccessError('Filesystem access changed during this task. Continue the task to start a new execution with the current authorization; no operation was retried.', 'operation_requires_approval', 'authorization_refresh_required')
      if (!alreadyApproved && this.workspaces.filesystemMode() !== 'project-only' && input && typeof input === 'object' && 'path' in input && typeof input.path === 'string') {
        const target = await absoluteTarget(input.path)
        if (this.workspaces.developerConfigurationPath(target) || sensitiveConfiguration(input.path)) {
          const protectedConfig = this.workspaces.developerConfigurationPath(target)
          if (!await chat.approve({ title: protectedConfig ? 'Access Claude/Codex configuration?' : 'Read hidden configuration?', description: `${tool.replaceAll('_', ' ')}: ${input.path}. ${protectedConfig ? 'This tree can contain credentials, including API tokens. File contents returned by this tool may be sent to the selected AI provider and saved in this conversation. Approve only if you intend to disclose them.' : 'Its contents may be sent to the active AI provider.'}` }, signal)) throw new FilesystemAccessError('Hidden configuration access was declined. No file contents were read.', 'operation_requires_approval', 'explicit_user_approval', target, true)
        }
      }
      await chat.beforeAction(tool, input, signal)
      read.assertAccess(); signal.throwIfAborted()
      if (this.workspaces.filesystemMode() !== initialAccess) throw new FilesystemAccessError('Filesystem access changed during this task. Continue to refresh authorization before retrying.', 'operation_requires_approval', 'authorization_refresh_required')
    }
    const approveCredential = async (tool: string, path: string, signal: AbortSignal) => {
      const target = await this.workspaces.credentialApprovalTarget(workspace, path)
      if (delegation) throw new FilesystemAccessError('A sub-agent cannot request access to credential-named files. Ask the parent to obtain explicit user authorization.', 'operation_requires_approval', 'credential_file_approval', target)
      if (!await chat.approve({ title: 'Read credential-named file?', description: `${tool.replaceAll('_', ' ')}: ${target}. This approves only this file read. It may contain real secrets; returned contents may be sent to the selected AI provider and saved in this conversation. Approve only if you intend to share this file with Athena.` }, signal)) throw new FilesystemAccessError('Credential-file access was declined. No file contents were read.', 'operation_requires_approval', 'credential_file_approval', target)
      if (this.workspaces.filesystemMode() !== initialAccess) throw new FilesystemAccessError('Filesystem access changed during approval. Continue to refresh authorization before retrying.', 'operation_requires_approval', 'authorization_refresh_required', target)
      signal.throwIfAborted()
    }
    const read = createProjectTools(this.workspaces, workspace, name, sources, selected, 80_000, settings, beforeAction, approveCredential)
    const successful = new Set<string>()
    const stagedByExecution = new Set<string>()
    const denied = new Set<string>()
    const freshReads = new Map<string, string>()
    const writes = new Set(['create_file', 'write_file', 'edit_file', 'apply_patch', 'delete_file', 'rename_file', 'move_file', 'create_directory', 'delete_directory', 'rename_directory', 'move_directory'])
    const isCommand = (tool: string) => tool === 'execute_command' || tool === 'start_dev_server' || tool === 'stop_dev_server' || tool.startsWith('run_') || tool.startsWith('git_')
    const blockedInReadOnly = (tool: string) => writes.has(tool) || isCommand(tool) || tool === 'revert_change'
    const availableDefinitions = definitions.filter(({ name }) =>
      !(effectiveMode === 'read-only' && blockedInReadOnly(name))
      && !(settings.allowProjectCommands === false && isCommand(name))
      && !(settings.allowProjectDeletion === false && ['delete_file', 'delete_directory', 'rename_file', 'move_file', 'rename_directory', 'move_directory'].includes(name)))
    let recovering = false
    let lastDiagnostics = 'No command has run in this request.'
    const approve = async (title: string, description: string, signal: AbortSignal, changes?: ChangePreview[], rememberScope?: RememberedScope) => {
      if (!await chat.approve({ title, description, changes, rememberScope }, signal)) throw new ChatError('User declined or cancelled this operation. Do not retry it without a new user instruction.')
      read.assertAccess(); signal.throwIfAborted()
    }
    const tools: ProjectTools = {
      policy: `Filesystem scope: ${commandScope()}. ${delegation ? 'This child is restricted to explicitly delegated project-relative paths and tools, even when the parent has Full Mac Access. It cannot obtain protected-file approvals or expand its scope.' : ''} Selected project is the default working directory, not the boundary when Full Mac Access is active. Use explicit absolute paths for other accessible locations. Full Mac Access permits explicitly targeted .claude and .codex files, including credential files, only after per-action user approval; their contents may reach the selected AI provider, so request them only when truly necessary. Other explicitly named credential files can be read through read_file after a separate approval for each read, including project fixtures; do not request this for unrelated files. A command that needs a credential-named fixture can request read_paths on execute_command for those exact files; user approval applies to that command only. If a command returns filesystemDenial, use its paths in read_paths instead of repeating the unchanged command or recommending chmod/chown. File-read approval does not automatically authorize command access. Protected directories, environment files, key material, symlinks and broad indexing remain blocked. Hidden configuration reads and edits require separate approval. For Git author name/email, call get_git_identity; Project Only commands use a scratch HOME; Full Mac commands use the local HOME, but both isolate global Git/npm configuration and retain sandbox credential restrictions. Never tell a user their Git identity is missing based on an isolated command. Project permission mode: ${effectiveMode}. ${effectiveMode === 'read-only' ? 'Only reading and searching are authorized. Mutating and command tools are not available.' : effectiveMode === 'advanced' ? 'Version-checked ordinary edits and isolated offline development commands are preauthorized within the selected workspace. Destructive file operations, sensitive configuration, network access, dependency installation, Git writes and external permissions still require separate approval.' : 'Source edits are available through version-checked file tools. Ask mode obtains approval for each proposed change; Workspace Auto Edit permits ordinary edits. Commands and destructive operations require explicit approval.'} Deletion/move requests: ${settings.allowProjectDeletion ? 'may request confirmation' : 'disabled'}. Command requests: ${settings.allowProjectCommands ? effectiveMode === 'advanced' ? 'isolated offline commands are preauthorized; risky commands still require confirmation' : 'may request confirmation' : 'disabled'}. A budget limit is NOT missing filesystem permission. Batch independent read-only tool requests when useful; Athena still checks each permission and runs writes sequentially. Never batch dependent writes before seeing the prior edit result and current file version. Reuse already returned evidence instead of repeating unchanged reads or searches. For a build command, inspect its approved plan and status, identify the next pending slice, implement a small unit, verify it, then continue only if budget permits. Do not restart completed slices on continuation.`,
      maxRounds: settings.maxAgentIterations, maxCalls: settings.maxToolCalls, timeoutMs: settings.maxExecutionMinutes * 60_000, maxArgumentBytes: 120_000,
      parallelSafe: (name) => ['read_file', 'list_directory', 'search_files', 'search_code', 'get_project_structure', 'get_file_metadata', 'inspect_dependencies', 'inspect_imports', 'find_symbol', 'find_references', 'analyze_project'].includes(name),
      definitions: [...read.definitions, ...availableDefinitions.map(({ name, description, schema }) => { const { $schema: _, ...parameters } = z.toJSONSchema(schema); return { name, description, parameters } })],
      assertAccess: read.assertAccess,
      invalidate: read.invalidate,
      dispose: delegation ? () => this.developmentServers.stopOwned(serverOwner, workspace) : undefined,
      continuation: () => { recovering = true; freshReads.clear(); read.invalidate?.() },
      execute: async (tool, input, signal) => {
        read.assertAccess(); signal.throwIfAborted()
        if (this.workspaces.filesystemMode() !== initialAccess) throw new FilesystemAccessError('Filesystem access changed during this task. Continue to refresh authorization before retrying.', 'operation_requires_approval', 'authorization_refresh_required')
        if (denied.has(tool)) throw new ChatError('This operation was already denied by project permissions or the user. Execution stopped without retrying it. Review Project access in Settings → AI, then explicitly continue if appropriate.')
        const detail = input && typeof input === 'object'
          ? 'query' in input && typeof input.query === 'string' && input.query.trim() ? input.query
            : 'symbol' in input && typeof input.symbol === 'string' && input.symbol.trim() ? input.symbol
            : 'path' in input && typeof input.path === 'string' && input.path.trim() ? input.path : ''
          : ''
        const visibleDetail = detail && !sensitiveContent(detail) ? detail.replace(/\s+/g, ' ').slice(0, 160) : detail ? '[sensitive target]' : ''
        const activity = chat.activity(tool, `${tool.replaceAll('_', ' ')}${visibleDetail ? ` · ${visibleDetail}` : ''}`)
        let changes: ChangePreview[] | undefined
        try {
          const definition = definitions.find((entry) => entry.name === tool)
          if (!definition) {
            const result = await read.execute(tool, input, signal), data = JSON.parse(result)
            if (tool === 'read_file' && typeof data.version === 'string' && typeof data.path === 'string' && typeof data.content === 'string') freshReads.set(data.path, data.version)
            chat.finishActivity(activity, { status: data.error ? 'error' : 'complete', summary: data.error ?? (data.path ? `${data.path}${data.version ? ` · version ${data.version.slice(0, 12)}` : ''}` : 'Project evidence returned.') }); return result
          }
          const parsed = definition.schema.safeParse(input)
          if (!parsed.success) throw new ChatError('Invalid tool arguments. Follow the advertised schema exactly.')
          const args = parsed.data as Record<string, unknown>
          const key = `${tool}:${JSON.stringify(args)}`
          if (successful.has(key) && tool !== 'start_dev_server') throw new ChatError('This operation already succeeded in this request; do not duplicate it.')
          const command = isCommand(tool)
          if ((effectiveMode === 'read-only' || this.workspaces.filesystemMode() === 'full-read-only') && blockedInReadOnly(tool)) throw new FilesystemAccessError('Read Only mode blocks changes and command execution. Change the relevant permission mode before retrying.', 'filesystem_policy_denied', 'tool_read_only', typeof args.path === 'string' ? args.path : undefined)
          const deletes = tool === 'rename_directory' || tool === 'move_directory' || tool === 'delete_file' || tool === 'delete_directory' || tool === 'move_file' || tool === 'rename_file' || (tool === 'apply_patch' && (args.changes as Array<{ content: string | null }>).some((item) => item.content === null))
          if (deletes && !settings.allowProjectDeletion) throw new ChatError('Project deletion/move permission is disabled in Settings → AI → Project access. No changes were made.')
          if (command && !settings.allowProjectCommands) throw new ChatError('Project command execution is disabled in Settings → AI → Project access. No command was run.')
          if (workspace === FULL_MAC_WORKSPACE_ID && command && tool !== 'stop_dev_server' && (tool !== 'execute_command' && tool !== 'start_dev_server' || typeof args.working_directory !== 'string')) throw new ChatError('Select a project or provide a specific approved working_directory for this command. The entire home folder is not a command sandbox.')
          let protectedConfigurationApproved = false
          if (writes.has(tool) && this.workspaces.filesystemMode() !== 'project-only') {
            const targets = tool === 'apply_patch' ? (args.changes as Array<{ path: string }>).map((item) => item.path)
              : [args.path, args.destination].filter((item): item is string => typeof item === 'string')
            const protectedTargets = (await Promise.all(targets.map(async (target) => ({ target, absolute: await absoluteTarget(target) })))).filter(({ absolute }) => this.workspaces.developerConfigurationPath(absolute))
            if (protectedTargets.length) {
              await approve('Access Claude/Codex files', `This operation may read existing contents of ${protectedTargets.map(({ target }) => target).join(', ')} while preparing a change. These files may contain credentials; their contents may reach the selected AI provider and be saved in the conversation or local recovery record. Approve this access before reviewing the proposed change.`, signal)
              protectedConfigurationApproved = true
            }
          }
          let result: unknown
          if (writes.has(tool)) {
            if (tool === 'rename_directory' || tool === 'move_directory' || tool === 'delete_directory' && args.recursive === true) {
              const prepared = await this.edits.prepareTree(session, workspace, String(args.path), tool === 'delete_directory' ? undefined : String(args.destination))
              changes = prepared.map(item => item.preview)
              chat.stageChanges(activity, changes)
              await approve('Review directory operation', 'All listed files are included. New changes after this preview will stop the operation. Recovery is preserved.', signal, changes)
              await beforeAction(tool, args, signal, protectedConfigurationApproved)
              signal.throwIfAborted(); read.assertAccess()
              changes = await this.edits.apply(prepared, signal); read.invalidate?.(); freshReads.clear()
              result = { ok: true, path: args.path, destination: args.destination, verified: true, changes: changes.map(({ id, path, status }) => ({ id, path, status })) }
            } else if (tool === 'create_directory' || tool === 'delete_directory') {
              const prepared = await this.edits.prepareDirectory(session, workspace, String(args.path), tool === 'delete_directory')
              changes = prepared.map((item) => item.preview)
              chat.stageChanges(activity, changes)
              if (effectiveMode === 'ask' || tool === 'delete_directory' || sensitiveConfiguration(String(args.path))) await approve(tool.replaceAll('_', ' '), String(args.path), signal, changes, tool === 'create_directory' && workspace !== FULL_MAC_WORKSPACE_ID && !sensitiveConfiguration(String(args.path)) ? { operation: tool, project: await this.workspaces.authorizedRoot(workspace), resources: [await absoluteTarget(String(args.path))] } : undefined)
              await beforeAction(tool, args, signal, protectedConfigurationApproved)
              signal.throwIfAborted(); read.assertAccess()
              changes = await this.edits.apply(prepared, signal)
              result = { ok: true, path: args.path, changes: changes.map(({ id, path, status }) => ({ id, path, status })) }
            } else {
              let proposals: EditProposal[]
              const path = String(args.path), expected = String(args.expected_version)
              if (recovering) {
                const targets = tool === 'apply_patch' ? args.changes as Array<{ path: string; expected_version: string | null }> : tool === 'create_file' ? [] : [{ path, expected_version: expected }]
                if (targets.some((target) => target.expected_version !== null && freshReads.get(target.path) !== target.expected_version)) throw new ChatError('Read each existing target with read_file after continuation before modifying it. Use its current version; earlier file evidence may be stale.')
              }
              if (tool === 'apply_patch') proposals = (args.changes as Array<{ path: string; expected_version: string | null; content: string | null }>).map((item) => ({ path: item.path, expected: item.expected_version, content: item.content }))
              else if (tool === 'edit_file') {
                const text = await this.edits.contents(workspace, path, expected), old = String(args.old_text)
                if (!text.includes(old) || text.indexOf(old) !== text.lastIndexOf(old)) {
                  // A corrective reread must return contents, not the duplicate
                  // evidence notice that otherwise traps the agent in retries.
                  read.invalidate?.()
                  throw new ChatError(!text.includes(old)
                    ? 'Edit not applied: old_text was not found in the current file. Read it again, omit read_file line-number prefixes, and preserve exact whitespace and line endings.'
                    : 'Edit not applied: old_text matches multiple locations. Read the file again and include unique surrounding lines. No file was changed.')
                }
                proposals = [{ path, expected, content: text.replace(old, () => String(args.new_text)) }]
              } else if (tool === 'rename_file' || tool === 'move_file') proposals = [{ path, expected, content: null }, { path: String(args.destination), expected: null, content: await this.edits.contents(workspace, path, expected) }]
              else proposals = [{ path, expected: tool === 'create_file' ? null : expected, content: tool === 'delete_file' ? null : String(args.content) }]
              const prepared = await this.edits.prepare(session, workspace, proposals)
              const syntax = validateSource && !['rename_file', 'move_file', 'delete_file'].includes(tool)
                ? await Promise.all(proposals.filter(item => item.content !== null).map(async item => {
                  const check = await checkSourceSyntax(item.path, item.content!); requireValidSource(check); return check
                })) : []
              signal.throwIfAborted()
              if ((tool === 'rename_file' || tool === 'move_file') && prepared.length === 2) prepared[1].record.mode = prepared[0].record.mode
              changes = prepared.map((item) => item.preview)
              chat.stageChanges(activity, changes)
              if (prepared.length && (effectiveMode === 'ask' || proposals.some((item) => item.content === null || sensitiveConfiguration(item.path)))) await approve('Review project changes', `${prepared.length} file(s). Existing versions will be checked again before applying.`, signal, changes, !deletes && workspace !== FULL_MAC_WORKSPACE_ID && ['create_file', 'write_file', 'edit_file', 'apply_patch'].includes(tool) && proposals.every(item => item.content !== null && !sensitiveConfiguration(item.path)) ? { operation: tool as RememberedScope['operation'], project: await this.workspaces.authorizedRoot(workspace), resources: await Promise.all(proposals.map(item => absoluteTarget(item.path))) } : undefined)
              if (prepared.length) await beforeAction(tool, args, signal, protectedConfigurationApproved)
              read.assertAccess(); changes = await this.edits.apply(prepared, signal); read.invalidate?.(); freshReads.clear()
              result = { ok: true, verified: true, verification: proposals.map(item => ({ path: item.path, exists: item.content !== null, version: versionOf(item.content) })), syntax,
                changes: changes.map(({ id, path, status }) => ({ id, path, status })), note: 'Saved bytes/absence verified against the approved changes. Syntax results apply to identical saved bytes. Project type checks and tests have not been run.' }
            }
            successful.add(key)
          } else if (command) {
            if (sensitiveContent(JSON.stringify(args))) throw new ChatError('Commands containing possible credentials are not accepted. Do not pass secrets in command arguments.')
            const explicitDirectory = typeof args.working_directory === 'string' ? args.working_directory : undefined
            const root = (tool === 'execute_command' || tool === 'start_dev_server') && explicitDirectory ? await this.workspaces.commandDirectory(workspace, explicitDirectory) : await this.workspaces.commandRoot(workspace)
            let request: CommandRequest = { executable: this.commands.packageManager(root), args: [], network: false, install: false, gitWrite: false, filesystemMode: commandScope() }
            let gitAddedPaths: string[] = []
            if (tool === 'execute_command') request = { ...request, executable: String(args.executable), args: args.args as string[], network: Boolean(args.network), loopback: Boolean(args.local_network), install: Boolean(args.install_dependencies) }
            else if (tool.startsWith('run_')) {
              const candidates: Record<string, string[]> = { run_tests: ['test'], run_linter: ['lint'], run_typecheck: ['typecheck', 'type-check', 'check'], run_build: ['build'] }
              const info = await this.workspaces.readRange(workspace, 'package.json', 1, 400, signal)
              const manifest = JSON.parse(await this.edits.contents(workspace, 'package.json', info.version))
              const scripts = manifest.scripts ?? {}, script = candidates[tool].find((item) => typeof scripts[item] === 'string')
              if (!script) throw new ChatError('No matching package.json script exists. Inspect project conventions and request an explicit command instead.')
              request.args = ['run', script]
              request.loopback = Boolean(args.local_network)
            } else {
              request.executable = 'git'
              const base = ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'credential.helper=']
              const gitArgs: Record<string, string[]> = { git_status: ['status', '--short', '--branch'], git_diff: ['diff', '--no-ext-diff', '--no-textconv'], git_staged_diff: ['diff', '--cached', '--no-ext-diff', '--no-textconv'], git_conflicts: ['diff', '--name-only', '--diff-filter=U'], git_reflog: ['reflog', 'show', '-10', '--format=%h %gD'], git_stash_list: ['stash', 'list', '--format=%gd %H'], git_log: ['log', '-10', '--format=%h %s'], git_repository_root: ['rev-parse', '--show-toplevel'], git_remotes: ['remote', '-v'], git_branch: ['branch', '--list'] }
              request.args = [...base, ...(gitArgs[tool] ?? [])]
              if (tool === 'git_show_commit') request.args = [...base, 'show', '--no-patch', '--format=%H%n%an%n%ad%n%s', String(args.commit)]
              if (tool === 'git_remote_ref' || tool === 'git_fetch_branch') {
                const branch = String(args.branch)
                if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,99}$/.test(branch) || branch.includes('//') || branch.endsWith('/')) throw new ChatError('Use a simple remote branch name without Git revision syntax.')
                request.args = [...base, ...(tool === 'git_remote_ref' ? ['rev-parse', `origin/${branch}`] : ['fetch', 'origin', branch])]
                if (tool === 'git_fetch_branch') { request.network = true; request.gitWrite = true }
              }
              if (tool === 'git_diff' || tool === 'git_staged_diff') {
                const tree = await this.workspaces.structure(workspace, '', 8, signal)
                const paths = tree.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path)
                if (!paths.length) throw new ChatError('No allowed source files are available for a diff.')
                request.args.push('--', ...paths)
              }
              if (tool === 'git_branch' && args.create !== null) {
                if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,99}$/.test(String(args.create))) throw new ChatError('Use a simple branch name without revision syntax.')
                request.args = [...base, 'branch', '--', String(args.create)]; request.gitWrite = true
              }
              if (tool === 'git_add') {
                gitAddedPaths = await Promise.all((args.paths as string[]).map(async (path) => {
                  const target = await this.workspaces.editTarget(workspace, path)
                  const stat = await lstat(target.absolute).catch(() => null)
                  if (stat && !stat.isFile()) throw new ChatError('Git staging requires explicit ordinary files, not directories or symlinks.')
                  const normalized = relative(root, target.absolute)
                  if (!normalized || normalized === '..' || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) throw new ChatError('Git staging target is outside the selected repository root.')
                  return normalized
                }))
                if (!stagedByExecution.size) {
                  const prior = await this.commands.execute(root, { executable: 'git', args: [...base, 'diff', '--cached', '--name-only', '-z'], network: false, install: false, gitWrite: false, filesystemMode: commandScope() }, signal)
                  if (prior.exitCode !== 0 || prior.timedOut || prior.truncated) throw new ChatError('Git index could not be checked before staging. No files were staged.')
                  if (prior.stdout) throw new ChatError('Git index already has staged files from outside this execution. Review or clear them separately before automatic per-slice staging.')
                }
                request.args = [...base, 'add', '--', ...gitAddedPaths]; request.gitWrite = true
              }
              if (tool === 'git_commit') {
                const review = await inspectStagedCommit(this.commands, root, signal)
                if (review.changes.some((change) => !stagedByExecution.has(change.path)) || !review.changes.length) throw new ChatError('Commit blocked: the index contains files not staged by this execution. No unrelated files will be committed.')
                const author = await this.gitIdentity.read(root, signal)
                if (author.name.status !== 'found' || author.email.status !== 'found') {
                  const details = [author.name.status !== 'found' ? `user.name: ${author.name.message}` : '', author.email.status !== 'found' ? `user.email: ${author.email.message}` : ''].filter(Boolean).join(' ')
                  throw new ChatError(`Commit blocked: Git author identity could not be verified. ${details} No commit was created.`)
                }
                await approve('Create Git commit', `Repository: ${review.root}\nBranch: ${review.branch}\nStaged: ${review.summary}\nAuthor: ${author.name.value} <${author.email.value}>\nMessage: ${args.message}\nReview every staged file diff below. Unstaged and untracked files are not included. No push will occur.`, signal, review.changes)
                await beforeAction(tool, args, signal)
                await assertStagedCommitUnchanged(this.commands, review, signal)
                // The isolated command environment intentionally hides global
                // Git config. Pass only the two verified values for this one
                // commit; never alter repository or global configuration.
                request.args = [...base, '-c', `user.name=${author.name.value}`, '-c', `user.email=${author.email.value}`, 'commit', '--no-gpg-sign', '-m', String(args.message)]; request.gitWrite = true
              }
            }
            if (delegation && request.network) throw new ChatError('This sub-agent has no delegated external internet permission.')
            if (delegation && request.loopback && !delegation.localNetwork) throw new ChatError('This sub-agent has no delegated local-network permission. Include local-network in its tool scopes before launching it.')
            if (tool === 'start_dev_server') {
              if (effectiveMode !== 'advanced') await approve('Start managed local development server', `Working directory: ${root}\nScript: ${args.script ?? 'auto-detect dev/start/serve/preview'}\nArguments: ${JSON.stringify(args.script_args ?? [])}\nReadiness: ${args.readiness_url ?? 'advertised loopback URL or PORT hint'}\nRestart owned project server: ${args.restart === true}\nNetwork: loopback only. Athena itself stays running.`, signal)
              await beforeAction(tool, args, signal)
              read.assertAccess()
              const filesystemMode = commandScope()
              const result = await this.developmentServers.start(serverOwner, root, args.script as string | undefined, filesystemMode, signal, (output) => chat.updateActivityOutput(activity, output), serverAuthorized,
                { projectId: workspace, serverId: args.server_id as string | undefined, restart: args.restart === true, readinessUrl: args.readiness_url as string | undefined, scriptArgs: args.script_args as string[] | undefined })
              lastDiagnostics = JSON.stringify(result)
              chat.updateActivityLabel(activity, `Development server ready · ${result.url}`)
              successful.add(key)
              chat.finishActivity(activity, { status: 'complete', summary: `Ready at ${result.url}` })
              return JSON.stringify({ untrusted_data: true, result })
            }
            if (tool === 'stop_dev_server') {
              const stopped = await this.developmentServers.stop(serverOwner, args.server_id as string | undefined, workspace)
              result = { stopped, message: stopped ? 'Managed development server stopped.' : 'No managed development server was running.' }
              lastDiagnostics = JSON.stringify(result)
            } else {
              if (!await this.commands.supported()) throw new ChatError('Secure command isolation is unavailable. Terminal/Git execution is disabled; run this check manually.')
              const requestedReads = tool === 'execute_command' ? args.read_paths as string[] | undefined : undefined
              if (requestedReads?.length && delegation) throw new FilesystemAccessError('Sub-agents cannot expand command access to credential-named files. Run this check in the parent task with explicit user approval.', 'operation_requires_approval', 'command_read_scope')
              const approvedReads = requestedReads?.length ? validateCommandReadPaths(root, requestedReads) : []
              if (tool !== 'git_commit' && (effectiveMode !== 'advanced' || request.network || request.loopback || request.install || request.gitWrite || approvedReads.length)) await approve(approvedReads.length ? 'Allow command to read these files?' : 'Run isolated command', `${request.executable} ${request.args.join(' ')}\nWorking directory: ${root}\nFilesystem scope: ${request.filesystemMode ?? 'project-only'}. Network: ${request.network ? 'allowed (external) — project data may leave this device' : request.loopback ? 'outbound loopback only (localhost, 127.0.0.1, ::1); no listening socket or external internet' : 'blocked'}. Dependency writes: ${request.install ? 'allowed' : 'blocked'}. Source-file writes are blocked.${approvedReads.length ? `\nRead access for this command only:\n${approvedReads.join('\n')}\nThese files may contain credentials. The command can read them; any contents it prints may be sent to the AI provider and saved in this conversation.` : ''}`, signal, undefined, sandboxCommandScope(root, { ...request, approvedReadPaths: approvedReads }, this.commands.executable(request.executable), tool))
              if (approvedReads.length) request.approvedReadPaths = approvedReads
              if (tool !== 'git_commit') await beforeAction(tool, args, signal)
              read.assertAccess()
              if ((tool === 'execute_command' || tool === 'start_dev_server') && explicitDirectory) {
                if (await this.workspaces.commandDirectory(workspace, explicitDirectory) !== root) throw new ChatError('Working directory changed before command execution.')
              } else if (await this.workspaces.commandRoot(workspace) !== root) throw new ChatError('Project root changed before command execution.')
              chat.updateActivityLabel(activity, `${request.executable} ${request.args.join(' ')}`)
              result = await this.commands.execute(root, request, signal, (output) => chat.updateActivityOutput(activity, output))
              if ((result as { exitCode?: number }).exitCode === 0 && tool === 'git_add') for (const path of gitAddedPaths) stagedByExecution.add(path)
              if ((result as { exitCode?: number }).exitCode === 0 && tool === 'git_commit') stagedByExecution.clear()
            }
            if (tool === 'git_status') {
              const status = result as { exitCode: number | null; output: string }
              const lines = status.output.split('\n').filter((line) => !sensitivePath(line))
              if (lines.some((line) => /:\s*(?:Operation not permitted|Permission denied|EACCES|EPERM)\b/i.test(line))) {
                // Some Git versions return exit 0 after reporting unreadable
                // tracked files on stderr. Never present that as a clean status.
                status.exitCode = 1
                lines.unshift('Git status is incomplete because tracked working-tree paths could not be inspected. This does not prevent an index-only staged commit review.')
              }
              status.output = lines.join('\n')
            }
            if (tool === 'git_conflicts') {
              const conflicts = result as { output: string }
              conflicts.output = conflicts.output.split('\n').filter(line => !sensitivePath(line)).join('\n')
            }
            lastDiagnostics = JSON.stringify(result)
            if (request.gitWrite || request.install) successful.add(key)
          } else if (tool === 'get_git_identity') {
            if (this.workspaces.filesystemMode() === 'project-only' && effectiveMode !== 'advanced') await approve('Read Git identity', 'Read only user.name and user.email from the repository and your global Git configuration. No Git settings will be changed.', signal)
            await beforeAction(tool, args, signal)
            const root = await this.workspaces.commandRoot(workspace)
            chat.updateActivityLabel(activity, 'Checking Git identity')
            result = await this.gitIdentity.read(root, signal)
            read.assertAccess()
          } else if (tool === 'verify_local_app') {
            if (!this.browserAutomationAllowed()) throw new ChatError('Browser verification is not authorized. Enable Local Browser Verification in Settings → Permissions. This permission is separate from filesystem access.')
            const filesystemMode = commandScope()
            const server = this.developmentServers.get(serverOwner, filesystemMode, serverAuthorized, workspace, args.server_id as string | undefined)
            if (!server) throw new ChatError('Browser verification blocked: this project server handle is missing or stale. Start the project script and use the returned server id. Athena and the conversation remain running.')
            await this.developmentServers.verifyReachable(serverOwner, String(args.path), filesystemMode, serverAuthorized, workspace, server.id)
            await beforeAction(tool, args, signal)
            chat.updateActivityLabel(activity, `Browser verification · ${args.viewport === 'mobile' ? '390 × 844' : '1280 × 800'}`)
            result = await this.browserVerification.inspect(server.url, String(args.path), args.viewport as BrowserViewport, args.selectors as string[], signal)
            lastDiagnostics = JSON.stringify({ viewport: (result as { viewport?: unknown }).viewport, consoleErrors: (result as { consoleErrors?: unknown }).consoleErrors })
          } else if (tool === 'list_changes') result = this.edits.history(session, workspace)
          else if (tool === 'review_change') {
            const record = this.edits.history(session, workspace).find((item) => item.id === args.id)
            if (!record) throw new ChatError('Change record does not belong to this conversation.')
            if (this.workspaces.filesystemMode() !== 'project-only' && this.workspaces.developerConfigurationPath(await absoluteTarget(record.path))) await approve('Review Claude/Codex file change', `The saved diff for ${record.path} may contain credentials and will be sent to the selected AI provider.`, signal)
            result = await this.edits.review(session, workspace, String(args.id))
          }
          else if (tool === 'revert_change') {
            const preview = await this.edits.review(session, workspace, String(args.id))
            await approve('Revert project change', 'Restore the previous version only if no newer edits exist.', signal, [preview])
            await beforeAction(tool, args, signal)
            changes = [await this.edits.revert(session, workspace, String(args.id), signal)]
            chat.changeReverted(changes[0]); successful.add(key); read.invalidate?.(); result = { ok: true, changes: changes.map(({ id, path, status }) => ({ id, path, status })) }
          } else if (tool === 'inspect_errors') result = { diagnostics: lastDiagnostics }
          else if (tool === 'inspect_dependencies' || tool === 'inspect_imports') {
            result = JSON.parse(await read.execute('read_file', { path: tool === 'inspect_dependencies' ? 'package.json' : String(args.path), start_line: 1, end_line: 400 }, signal))
          }
          else if (tool === 'analyze_project') result = JSON.parse(await read.execute('get_project_structure', { path: '', depth: 5 }, signal))
          else if (tool === 'retrieve_relevant_context') { await beforeAction(tool, args, signal); result = await this.workspaces.retrieve([workspace], String(args.question), signal, Math.min(settings.maxFileReadChars, settings.maxToolOutputChars)); sources.push(...(result as { sources: SourceReference[] }).sources) }
          else {
            result = JSON.parse(await read.execute('search_code', { path: '', query: String(args.symbol), glob: '**/*', mode: 'symbol', case_sensitive: true, offset: 0 }, signal))
          }
          const modelResult = command && result && typeof result === 'object' && 'output' in result && typeof result.output === 'string' ? { ...result, output: summarizeLog(result.output, Math.max(500, settings.maxToolOutputChars - 1500)) } : result
          const output = JSON.stringify({ untrusted_data: true, result: modelResult })
          const gitIdentityResult = tool === 'get_git_identity' ? result as GitIdentity : undefined
          const browserReport = tool === 'verify_local_app' ? result as { viewport?: { width?: number; height?: number }; consoleErrors?: string[] } : undefined
          const failed = (!!result && typeof result === 'object' && 'exitCode' in result && result.exitCode !== 0)
            || (gitIdentityResult && [gitIdentityResult.name.status, gitIdentityResult.email.status].some((status) => ['permission-denied', 'tool-failure', 'timeout'].includes(status)))
            || Boolean(browserReport?.consoleErrors?.length)
          const summary = command ? summarizeLog(lastDiagnostics, 8000)
            : browserReport ? `Inspected ${browserReport.viewport?.width ?? 'unknown'} × ${browserReport.viewport?.height ?? 'unknown'} viewport; ${browserReport.consoleErrors?.length ?? 0} browser console errors.`
              : gitIdentityResult ? gitIdentityResult.complete ? 'Git identity found.' : 'Git identity check finished; inspect field statuses.' : 'Operation completed.'
          chat.finishActivity(activity, { status: signal.aborted ? 'cancelled' : failed ? 'error' : 'complete', summary, fullOutput: command ? lastDiagnostics.slice(0, 70000) : undefined, changes })
          return limitToolOutput(output, settings.maxToolOutputChars)
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
          if (code) log('agent.tool_os_failure', { tool, code, filesystemMode: this.workspaces.filesystemMode() })
          const pathHint = visibleDetail ? ` Target: ${visibleDetail}.` : ''
          const message = error instanceof ChatError ? error.userMessage : signal.aborted ? 'Operation cancelled.' : code === 'EPERM' || code === 'EACCES'
            ? `The operating system denied ${tool} (${code}).${pathHint} Check Athena’s selected Filesystem Access scope and macOS Privacy & Security access; Athena does not bypass either boundary. No success is implied.`
            : code === 'ENOENT' ? `The target required by ${tool} no longer exists (${code}).${pathHint} Refresh project state before retrying.`
              : error instanceof Error ? `${tool} failed${code ? ` (${code})` : ''}: ${error.message.replace(/\n/g, ' ').slice(0, 300)}${pathHint}`
                : 'Operation failed. No success is implied; inspect current files before retrying.'
          if (/Read Only mode blocks|permission is disabled|execution is disabled|User declined/.test(message)) denied.add(tool)
          chat.finishActivity(activity, { status: signal.aborted ? 'cancelled' : 'error', summary: message, changes })
          if (signal.aborted) throw new ChatError(message)
          const filesystemFailure = error instanceof FilesystemAccessError || ['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'EINVAL', 'EROFS', 'EIO', 'ELOOP'].includes(code ?? '')
          return JSON.stringify(filesystemFailure
            ? filesystemToolError(error, detail, tool, commandScope(), name, isCommand(tool) ? 'sandboxed-command' : writes.has(tool) || tool === 'revert_change' ? 'filesystem-write' : 'filesystem-read')
            : { error: message })
        }
      },
    }
    return tools
  }
}
