# Remembered permissions

Athena now offers Deny, Allow once, and Always allow on requests with a host-validated, unambiguous scope. Always allow is an extension of PermissionService and the existing permissions.json repository, not a provider-side blanket approval.

## Supported scopes

- Athena project tools: create_file, write_file, edit_file, apply_patch (without deletion), and create_directory. Grants match the exact operation and exact set of canonical resources, within the same project directory identity.
- Cursor ACP: native read operations on exact validated project files. Cursor receives allow-once after Athena checks each request. Native edits remain one-time approvals because this adapter cannot reliably distinguish replacements from deletions.
- Desktop tools: opening or focusing one known application, and opening one exact HTTP(S) URL. URL credentials, query strings, fragments, and sensitive authorization/reset paths cannot be remembered.
- Online, Local Athena, floating conversations, and delegated tool approvals share the main-process service. Delegation and read-only restrictions still run independently.

Ordinary project reading already authorized by workspace selection does not gain a new prompt. OS permission dialogs remain under OS control. Hidden configuration, credential files, screen sharing, deletions, moves, Git mutations/commits, arbitrary terminal commands, and ambiguous operations retain existing checks and one-time confirmations. This implementation deliberately does not grant recursive directory wildcards or unrestricted terminal access.

## Persistence and security

Settings → Privacy → Remembered permissions displays the operation, exact resources, project, grant time, active/disabled/revoked state, and revocation history. Individual revocation, revoke all, and a global enable switch persist immediately. Disabling pauses existing grants; re-enabling restores only non-revoked, still-valid grants.

Records are schema-validated and saved atomically in the existing permission file with owner-only creation permissions. Existing OS opt-ins and provider-bound filesystem grants are preserved. Records contain no file contents or authentication tokens. Grants are created only from a live host-owned pending request in response to an explicit user decision; settings IPC cannot create grants.

Matching resolves canonical paths, requires exact operations/resources, rejects traversal and sensitive targets, and checks the project directory's device/inode/birth time. Replacing a project at the same path does not revive its grants. Symlink escapes and changed targets do not reuse a grant. Existing workspace authorization, file-version checks, cancellation, OS consent, and sub-agent restrictions remain enforced. Grants, automatic approvals, global changes and revocations use the existing audit logger; automatic approvals include conversation/task context.

Permission history is bounded at 2,000 records; reaching the bound fails closed and leaves Allow once available. Grants are never silently removed to make room.

## Changed files

Contracts:
- shared/permissions.ts
- shared/agent.ts
- shared/conversations.ts
- shared/contracts.ts
- shared/ipcChannels.ts

Main process and bridge:
- electron/main/permissions/rememberedPermissions.ts (new)
- electron/main/permissions/permissionRepository.ts
- electron/main/permissions/permissionService.ts
- electron/main/ai/chatController.ts
- electron/main/ai/agentTools.ts
- electron/main/ai/AIProvider.ts
- electron/main/ai/cursorACP.ts
- electron/main/ai/subagentCoordinator.ts
- electron/main/desktop/desktopTools.ts
- electron/main/main.ts
- electron/main/ipcHandlers.ts
- electron/preload/preload.ts

Renderer:
- src/components/ApprovalActions.tsx (new shared controls)
- src/features/chat/AgentActivity.tsx
- src/features/athena-ai/AthenaChat.tsx
- src/features/floating/FloatingConversation.tsx
- src/features/settings/PermissionSettings.tsx
- src/store/permissionStore.ts
- src/services/desktop.ts

Tests:
- tests/rememberedPermissions.test.ts (new)
- tests/approvalActions.test.tsx (new)
- tests/cursorRememberedPermissions.test.ts (new)
- tests/desktop/rememberedPermissions.spec.ts (new)
- tests/permissionRepository.test.ts
- tests/agentTools.test.ts

## Verification

Behavioral coverage includes persistence, revocation, disable/re-enable, Allow once versus Always allow, online/local sharing, exact operation and project isolation, traversal and symlinks, replaced projects, malformed records, failed persistence, forged decisions, cancellation, mandatory approvals, real isolated project-file writes, Read Only enforcement, and Cursor read/edit/delete/execute routing using a controlled ACP transport.

The Electron desktop test uses a temporary profile and a seeded grant fixture to verify visible management controls, secure IPC (no renderer grant endpoint), and disable/revoke persistence across actual app restarts. Actual user-driven grant creation is tested through ChatController and real file-tool execution, not inferred from the seeded UI fixture.

Cursor terminal tests exercise the existing macOS sandbox in temporary repositories. They require execution outside the surrounding coding-agent sandbox, which cannot start a nested sandbox. No user repository is staged or committed by these fixtures.

No paid/live provider request is needed by these tests. Windows native UI execution is not verified on this Mac. Cursor transport scopes are tested with controlled messages, not a live provider turn.

Final verification on this Apple Silicon Mac: typecheck passed; production build and macOS packaging passed; 13 targeted Vitest suites passed (206 passed, 3 skipped); the Electron desktop persistence test passed. Skips were existing opt-in sandbox Git/loopback tests and a fixture-dependent MBM-11400 sub-agent test whose external fixtures were unavailable. The other Cursor sandbox terminal tests passed outside the enclosing Codex sandbox. No live provider turn or Windows desktop run was claimed.


## Offline command follow-up

The initial implementation intentionally excluded all command prompts, which omitted Always allow from Cursor’s “Run isolated project command” npm test prompt. This is now connected through cursorTerminal.ts and agentTools.ts using a shared sandboxCommandPermission.ts scope builder.

Eligible commands are exact npm/pnpm/yarn test, test:unit, test:ci, lint, lint:check, typecheck, type-check, and format:check invocations. The grant binds the adapter/tool, exact ordered arguments, canonical project identity, executable path and file identity, package.json hash, and versioned offline project-only sandbox policy. Changing any of these requires approval again. Network/loopback/listening, installs, Git writes, expanded filesystem scope, credential read_paths, and source-changing or workspace-override flags cannot be remembered. The existing execution sandbox is unchanged.

New coverage: tests/sandboxCommandPermission.test.ts, an actual sandboxed npm test persistence/reuse test in tests/cursorTerminal.test.ts, and a command-prompt rendering regression in tests/approvalActions.test.tsx. Additional modified files: shared/permissions.ts, rememberedPermissions.ts, cursorTerminal.ts, agentTools.ts, ApprovalActions.tsx, PermissionSettings.tsx. Existing pending prompts were created by the old process and need a new request after restart; they are not retroactively authorized.

Follow-up verification: typecheck passed; 86 targeted tests passed (1 existing opt-in sandbox test skipped); Cursor terminal suite passed 8 tests (1 existing opt-in loopback test skipped). The new terminal test executes a real offline npm script twice through the macOS sandbox and reloads the grant repository between runs; only one approval is required. Screenshot-style arguments are covered without running the user's Metrobank tests or modifying that project.
The Electron desktop permission-management/restart test also passed for the follow-up build.
