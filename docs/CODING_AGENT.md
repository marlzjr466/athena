# Athena coding agent

## Using it

Authorize a project with the existing folder picker, choose a tool-capable OpenAI model, and choose the conversation's **Coding agent permissions** selector. The default is **Ask Before Changes**. Ask Athena to inspect or change actual project files. Approvals, diffs, operation results and elapsed time appear with its response.

- **Read Only:** repository exploration; no edits or command execution.
- **Ask Before Changes:** automatic reads; file and command approvals.
- **Workspace Auto Edit:** ordinary version-checked source edits and offline verification scripts can run without individual approval. Deletion, larger changes, arbitrary command argument arrays, network/dependency operations and Git writes still require approval.
- **Advanced Agent:** the same hard boundaries and mandatory approvals, with a larger bounded tool loop (32 rounds / 96 calls, versus 24 / 80).

Approvals authorize one operation, not a permanent bypass. Changing sessions or stopping a response cancels pending approvals. Modes cannot change while a request runs. Unsupported models retain the existing explicitly labeled retrieval-only fallback.

## Real tools

Existing read tools remain available: `list_directory`, `read_file`, `search_files`, `search_code`, `get_project_structure`, `get_file_metadata`.

New source tools: `create_file`, `write_file`, `edit_file`, `apply_patch`, `delete_file`, `rename_file`, `move_file`, `create_directory`, `delete_directory`, `list_changes`, `review_change`, `revert_change`.

Development: `execute_command`, `run_tests`, `run_linter`, `run_typecheck`, `run_build`, `inspect_dependencies`, `inspect_errors`.

Git: `git_status`, `git_diff`, `git_log`, `git_branch` (list/create, no checkout or deletion), `git_add`, `git_commit`. No push, reset, clean, history rewrite, or remote-management tool exists. Git commits show the staged diff for approval and check staged object IDs again afterwards. Existing staged changes are not silently discarded. Hooks, signing and external diff programs are disabled in the curated Git workflow.

Navigation: `find_symbol`, `find_references`, `inspect_imports`, `analyze_project`, `retrieve_relevant_context`. Symbol/reference search is text-based, not semantic language-server resolution. Architectural conclusions must cite actual returned sources.

The provider preserves tool outputs and encrypted reasoning within a request, supports sequential mutations and up to four parallel safe reads, and stops on cancellation, context limits, deadlines or call limits. It never retries writes automatically. Subsequent conversation context includes truthful operation/change summaries, including interrupted turns.

## Editing and recovery

`read_file` returns a SHA-256 version of the current full UTF-8 file. Existing-file writes require that version; edits require a unique exact match. Batch patches preflight every target and recheck versions after approval. New files never overwrite existing files. Writes use an exclusive temporary sibling, flush and rename. Supported editable files are ordinary, non-hardlinked UTF-8 source files up to 256 KB. Existing sensitive-path/content, `.gitignore`, symlink and project-root checks remain enforced.

Local recovery records live in `agent-recovery` under Electron userData (directory mode 0700, records 0600). Records contain original/resulting contents and are saved before mutation. They are never automatically uploaded. The UI records change IDs before applying; interrupted changes can be recovered after the project is reauthorized. A revert refuses to overwrite newer user changes. Batch failure attempts version-checked rollback and preserves records for conflicts.

Empty directory creation/deletion is recoverable. Non-empty recursive deletion is intentionally not exposed as a single operation: inspect the tree, approve explicit file deletions, then remove empty directories. Directory moves can be composed from new directories and explicit file moves; protected or excluded contents cannot be moved through these tools. File moves are recoverable source/destination changes, not a cross-file atomic OS transaction. Multi-file changes are not a single filesystem transaction; preflight and recovery do not prevent another local process racing an operation.

Commands cannot modify source files; formatting/code generation that writes source must use file tools instead. Command-produced build outputs, dependency installations and Git operations are **not** covered by source-file undo. Review their actual outputs and use an explicitly authorized follow-up rather than assuming universal rollback.

## Command isolation

The native command runtime is macOS-only. It verifies allowed and denied reads through the production `sandbox-exec` profile before enabling execution. If verification fails, commands are disabled with an explicit error; there is no unrestricted fallback.

Commands use executable/argument arrays, not a shell endpoint. Executables are selected from known installed system/Homebrew/Command Line Tools locations. The environment is rebuilt without inherited keys/tokens. HOME, caches and temp files are request-private. Network is blocked by default; network-enabled operations require approval with an explicit data-sharing warning.

The profile allows system runtimes and the authorized workspace to be read, blocks common credential files, prevents outside-workspace writes and unrelated process signaling, and limits writes to private scratch and standard build output directories. Explicitly approved dependency operations additionally permit node_modules and package manifests/lockfiles. Git writes are allowed only for the curated Git operations. General commands cannot access the project's Git database. Commands time out after two minutes; output is bounded/redacted; cancellation terminates the process group. Background servers are not retained after completion.

This is a conservative local development sandbox, not a virtual machine or a guarantee against a compromised OS. Custom runtimes, user-home language managers, scripts needing additional system services, and alternate build-output paths can fail under the policy. The app reports failures rather than broadening permissions automatically.

## Timing, persistence and UI

One timestamp-based clock covers model latency, approvals, reads, edits and commands. It updates every second and does not reset between tools. Completion, error or cancellation stores the final timestamp and status; 90 seconds displays `Worked for 1m and 30s`. An interrupted app session uses the last persisted activity timestamp, not time spent with Athena closed.

The collapsible activity panel displays actual tool starts/results, modified-file diffs, command output/errors, approval controls and individual file recovery. It does not show private model reasoning or fabricate progress. Existing character state hooks are reused; character geometry, animations, flight and wandering code are unchanged.

Conversation config and execution metadata extend the existing local JSON store compatibly. No Supabase integration or migration was added. No new API-key configuration or runtime environment variables are required. Project authorization is still per application session; saved project metadata alone is not an access grant.

## Validation

- `npm run typecheck`
- `npm test` (includes real temporary-filesystem permission/edit/recovery cases, mocked OpenAI SSE multi-round edits, approval/cancellation/persistence, and live-timer rendering)
- `ATHENA_SANDBOX_TEST=1 npm run test -- tests/agentCommands.test.ts` outside any parent sandbox on macOS: real sandbox reads/writes/network denial, cancellation, npm script and Git fixture staging/commit.
- `npm run package`

The SSE tests use synthetic provider responses with the real OpenAI SDK, tool controller and filesystem. They do not prove a particular live model will solve every coding task. No paid API calls or remote Git operations are part of these tests.

## Source files

New: `shared/agent.ts`; `electron/main/ai/agentEdits.ts`, `agentCommands.ts`, `agentTools.ts`; `src/features/chat/AgentActivity.tsx`; `tests/agentEdits.test.ts`, `agentCommands.test.ts`, `agentTools.test.ts`, `agentActivity.test.tsx`; this document.

Modified: `shared/chat.ts`, `shared/conversations.ts`; `electron/main/main.ts`; `electron/main/ai/AIProvider.ts`, `OpenAIProvider.ts`, `chatController.ts`, `chatContextService.ts`, `conversationRepository.ts`, `contextBudget.ts`, `workspaceService.ts`, `projectTools.ts`; `src/features/chat/ChatMessage.tsx`, `ChatView.tsx`, `ConversationControls.tsx`; `src/styles/conversations.css`; `tests/projectTools.test.ts`, `projectConversation.test.ts`.
