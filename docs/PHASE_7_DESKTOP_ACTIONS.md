# Phase 7 — Safe desktop actions

Implemented four main-process tools through the existing conversation tool loop:

- `open_application`: launch an allowlisted installed app and verify it is running.
- `focus_application`: activate an already running app and verify it is frontmost.
- `open_url`: preview an HTTP(S) address for approval, then ask the default browser to open it.
- `show_notification`: submit a short silent notification, respecting Athena Do Not Disturb and rate limits.

Desktop Automation must be enabled in Privacy. Read Only blocks every action. Ask Before Changes previews every action; URL destinations always require approval, including in automatic modes. Permission and conversation identity are checked again after approval. Tool arguments are strictly validated; neither model-generated scripts nor shell commands are executed by these tools. Duplicate actions within a request reuse their receipt, and requests are bounded to eight distinct desktop actions. Cancellation, shutdown and native-operation timeouts are handled.

Supported app IDs: `vscode`, `chrome`, `safari`, `finder`, `terminal`, `slack`, `spotify`, `notes`, `calculator`. Opening an app does not run commands or open arbitrary files. Focus does not launch a stopped app. URL results distinguish OS submission from actual page loading. Notification results distinguish display confirmation from submission.

The existing model selection, approvals, task activity and agent recovery infrastructure are reused. No unrestricted desktop API is exposed to React. These basic actions do not require blanket Accessibility consent; Athena's opt-in remains mandatory. Existing OS grants are not changed.

## Files

Created:

- `shared/desktopActions.ts`
- `electron/main/desktop/desktopPlatform.ts`
- `electron/main/desktop/macOSDesktopPlatform.ts`
- `electron/main/desktop/desktopTools.ts`
- `tests/desktopTools.test.ts`
- `tests/macOSDesktopPlatform.test.ts`
- `tests/desktopConversation.test.ts`
- `docs/PHASE_7_DESKTOP_ACTIONS.md`

Modified:

- `electron/main/ai/chatContextService.ts`
- `electron/main/main.ts`
- `electron/main/permissions/macOSPermissionAdapter.ts`
- `shared/permissions.ts`
- `tests/macOSPermissionAdapter.test.ts`

## Validation and limitations

The full Vitest suite passed: 409 tests passed, one skipped. Coverage includes strict arguments, denied permissions, approval-time permission changes, Read Only mode, cancellation, duplicate suppression, URL restrictions, notification rate limits, native failure results, and the conversation-to-provider-to-approval-to-executor lifecycle. Native OS actions and provider responses are mocked in automated tests; a live API-driven desktop action has not been verified.

Runtime support is macOS only. Apps must be installed under their allowlisted bundle IDs. macOS can refuse activation or suppress notifications. Native function-calling models are required for conversation tool use. An action already dispatched to macOS cannot always be retracted on cancellation. No database migrations, new environment variables, or API-key changes are required.

Phase 8 and later capabilities are not part of this change.
