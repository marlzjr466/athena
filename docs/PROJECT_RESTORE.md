# Remembered project access and AI settings placement

Provider and context controls now live in Settings → AI. Model, effort and agent permission selectors remain in the composer. Context settings retain their existing per-conversation scope; the AI page identifies the active conversation and subscribes to its current state. Saving does not overwrite other sessions' settings.

## Restart fix

Previously, conversation history saved only project names/IDs and SHA-256 path fingerprints. WorkspaceService kept actual authorized roots only in RAM, so restarting necessarily lost access. Deleting conversations was never necessary and is not part of this fix.

Explicit folder selection now persists a separate private `workspace-grants.json` record under Electron userData (file mode 0600, atomic write). It stores the canonical root, project reference and filesystem device/inode. Absolute paths remain main-process-only; they are not sent through conversation IPC or to the model. No repository contents or credentials are included.

Before constructing renderer windows, startup restores only grants that match an existing conversation project ID/fingerprint, the canonical path, directory type and filesystem identity. It checks filesystem access and the Personal File Access preference. Symlinks, replaced/missing roots, unrelated references and invalid records fail closed. File tools retain their normal traversal, ignore, sensitive-file, permission and version checks.

Deleting a project, disconnecting its last conversation, or disabling Personal File Access removes the grant. Disconnecting one session does not revoke the other sessions' access. Renamed project labels come from current conversation metadata.

## Existing projects

An old fingerprint cannot be reversed to obtain the folder path. Projects selected before this update need one explicit re-selection of the same folder using Connect project folder or the new Reconnect project folder button. This reuses the existing ID, name and sessions, then remembers access for subsequent launches. **Do not delete the sessions.**

The existing `map-governance-ui` project was reauthorized once and verified after a full quit/relaunch: its existing project conversation remained present and no `select again` state was shown.

Moved/replaced directories or macOS-denied access may still require reauthorization. This implements persistent application consent for Athena's current non-App-Sandbox Electron build, not an OS permission bypass or a Mac App Store security-scoped bookmark implementation.

## Files

- New: `electron/main/ai/workspaceGrants.ts`, `tests/workspaceGrants.test.ts`, `tests/contextSettingsLocation.test.tsx`, this document.
- Moved/updated: `src/features/chat/ContextSettings.tsx` → `src/features/settings/ContextSettings.tsx`.
- Updated: `electron/main/main.ts`, `electron/main/ai/workspaceService.ts`, `electron/main/ai/chatContextService.ts`, `src/features/chat/ConversationControls.tsx`, `src/features/chat/WorkspacePanel.tsx`, `src/features/settings/AISettings.tsx`, `src/features/settings/GenerationSettings.tsx`, `src/styles/ai.css`, `src/styles/conversations.css`, `tests/aiSettings.test.tsx`.

No migrations, dependencies, cloud access, model generation, session deletion or Phase 4 implementation are involved.
