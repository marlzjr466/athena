# Project coding execution repair — 2026-10-11

## Evidence and root cause

The two saved `/platform-build MBM-11390` attempts contain 24 and 32 successful
operations respectively, no failed operations, and no attempted writes. They
used project reads/searches and Git status. This matches the former 24-round
standard / 32-round Advanced Agent caps exactly. The last request forced
`tool_choice: none`; the model then described its lack of tools in that final
request as unavailable project-operation access. The controller correctly marked
the task unfinished, but the explanation was misleading.

Existing `AgentTools` already advertised create/write/edit/patch/directory/move/
rename/delete tools through `ChatContextService` and the subscription namespace.
`AgentEdits` already performs real, version-checked, recoverable writes in the main
process. No parallel filesystem bridge or second coding agent was needed.

## Changes

- Persisted per-conversation bounded defaults: 64 iterations, 160 tool calls,
  30 minutes. Settings → AI → Context & task limits exposes ranges of 8–128,
  16–400 and 2–60 minutes. Permission mode no longer controls task budget.
- Removed the hidden 24/96 project-read ceiling in favor of configured call limits.
  Activity/checkpoint storage supports the bounded larger workload.
- Shared budget warnings at 75%; exhaustion stops locally with the actual cause,
  without another tool-disabled inference request. OpenAI, subscription, local
  Ollama and Claude API loops use the bounded lifecycle.
- Settings → AI → Project access displays the verified project root, read status,
  access mode, and whether deletion/move and development-command approvals are
  allowed. Grants apply to this project's conversation, not every project.
- Newly opened projects default to Ask Before Changes, even if the preceding
  project had an automatic-write grant. Permission changes stop active execution
  immediately; late approvals cannot apply.
- Commands now require confirmation in every write mode. Destructive operations
  retain existing diff approval. Repeated attempts at a denied tool terminate
  instead of wasting the whole task budget.
- Providers receive the actual project permission policy. Claude API model names
  supported by Athena's existing adapter can now use the native project tools.
- Continue unfinished task reuses original messages and actual operation receipts,
  expands the current slash definition, explicitly requests continuation rather
  than a fresh rerun, and requires fresh reads before editing existing files.
  Historical messages and completed edits are not deleted or rolled back.
- Recent context retains bounded summaries of the last 12 operation results.
- Cursor remains a separate supported native adapter, not Athena's tool loop.
  Terminal/network/MCP restrictions remain intact. Disabling deletion forces
  Cursor read-only because ACP cannot reliably distinguish all replacements from
  deletes. No paid provider fallback was added.

## Files

Created:
- `electron/main/ai/agentBudget.ts`
- `src/features/settings/ProjectAccessSettings.tsx`
- `tests/codingBudgetIntegration.test.ts`
- `docs/PROJECT_CODING_FIX.md`

Modified:
- `shared/context.ts`, `shared/agent.ts`, `shared/generation.ts`, `shared/conversations.ts`
- `electron/main/ai/AIProvider.ts`, `agentTools.ts`, `projectTools.ts`, `toolCallSession.ts`
- `electron/main/ai/OpenAIProvider.ts`, `OllamaProvider.ts`, `claudeAPI.ts`, `cursorACP.ts`
- `electron/main/ai/chatController.ts`, `chatContextService.ts`, `contextBudget.ts`
- `src/features/settings/ContextSettings.tsx`
- `src/features/chat/AgentActivity.tsx`, `ChatMessage.tsx`
- `tests/agentTools.test.ts`, `projectConversation.test.ts`, `openAIToolLoop.test.ts`,
  `chatController.test.ts`, `contextSettingsLocation.test.tsx`

No new dependencies, database migrations or user-project modifications.

## Validation

- Full automated suite: 651 passed; 3 opt-in tests skipped.
- Separately enabled real macOS sandbox suite: 4 passed. Verified temporary-project
  reads, rejection of outside reads and source writes, generated-output writes,
  blocked network and secret reads, process cancellation, an actual npm test script,
  and isolated Git operations. These operations used disposable fixtures only.
- Slash/provider regression: mocked subscription responses through the real
  ChatController, SlashCommandService, ChatContextService and AgentTools. After 33
  metadata calls, read then edit succeeded; the 36th response completed. Verified
  file bytes, preserved CRLF and unrelated text, saved change receipts, selected
  model/effort and registered file tools.
- Real-file tests cover mkdir/create/write/patch/rename/move/approved delete;
  read-only denial; cancellation; approval revocation; conflict preservation;
  traversal/symlink/ignored-file/secret rejection; recovery and continuation.
- TypeScript check and production build passed. Existing bundle-size and Zod
  annotation warnings remain; local packaging has no Developer ID certificate.
- Packaged and restarted `release/mac-arm64/Athena.app`; verified old PID 82727
  exited and exactly one new main process was running (PID 84382).

## Limits and next use

The actual MBM-11390 development workflow was not rerun or declared successful.
Its original command refers to native sub-agents, repository hooks, quality gates
and commits; Athena must not pretend unsupported native facilities ran. Explicit
command/commit approval and sandbox restrictions still apply.

Protected secrets remain blocked (no new secret-access override); directory deletion
remains empty-only, never recursive. Supported edits remain bounded UTF-8 files and
safe project paths. Existing Git inspection is retained; this change does not add
automatic commits or permission to overwrite unrelated user work. Native Cursor
has its own execution limits and does not inherit Athena's internal iteration loop.

In the existing project conversation, review **Settings → AI → Project access**,
choose **Ask Before Changes** or explicitly grant **Read & Write**, then use
**Continue unfinished task** on the failed reply. Approve only the proposed changes
and commands you want. No permission was silently upgraded by this repair.
