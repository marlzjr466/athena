# Phase 12 — Hardening and final review

## Changes

- IPC now requires the exact registered renderer document and surface, an owned window, and its top-level frame. Packaged builds ignore development renderer overrides. Async IPC failures are sanitized instead of exposing native error details.
- Permission revocation cancels affected work. Enabling an unrelated permission no longer cancels chat because personal-file access is off.
- OpenAI credit exhaustion, organization/project spending limits, temporary rate limits, overload, context limits, and output limits remain distinct. Raw provider errors and startup exception content are not logged.
- Model catalog and speech response bodies have byte limits and cancellation cleanup. Speech timeouts cover body streaming, not just response headers.
- Command output redaction covers authorization headers, quoted credentials, URL credentials, and truncated private keys.
- Workspace reads and edit snapshots use nonblocking opens before rejecting nonregular files, avoiding hangs on special files.
- Existing conversations, permissions, voice settings, character animations, motion controllers, and task-continuation behavior are preserved.

## Files

Created:

- `electron/main/rendererSecurity.ts`
- `electron/main/ai/apiErrors.ts`
- `electron/main/ai/responseBody.ts`
- `tests/rendererSecurity.test.ts`
- `tests/responseBody.test.ts`
- `tests/openAISpeechService.test.ts`
- `docs/PHASE_12_HARDENING.md`

Modified:

- `electron/main/windowManager.ts`
- `electron/main/ipcHandlers.ts`
- `electron/main/main.ts`
- `electron/main/ai/OpenAIProvider.ts`
- `electron/main/ai/openAIConnection.ts`
- `electron/main/voice/openAISpeechService.ts`
- `electron/main/voice/transcriptionService.ts`
- `electron/main/ai/agentCommands.ts`
- `electron/main/ai/agentEdits.ts`
- `electron/main/ai/workspaceService.ts`
- `tests/aiIPC.test.ts`
- `tests/openAIProvider.test.ts`
- `tests/openAIConnection.test.ts`
- `tests/transcriptionService.test.ts`
- `tests/agentCommands.test.ts`

## Verification

- `npm run typecheck`: passed.
- Focused security/provider/stream suite: 96 passed, one native sandbox test skipped by default.
- `npm test`: 498 passed, one skipped, across 55 test files.
- `ATHENA_SANDBOX_TEST=1 npm test -- tests/agentCommands.test.ts`: all four passed. Real macOS sandbox checks used temporary fixtures and verified workspace boundaries, blocked source writes, allowed build-output writes, blocked networking, cancellation, sensitive-file denial, package-script execution, and local Git operations.
- API tests use mocks. No real paid OpenAI calls, microphone recordings, screen captures, or user repository mutations were performed during this review.

## Configuration and limitations

No dependencies, environment variables, database migrations, or Supabase structures were added. Persistence remains local. Native permissions and paid-provider behavior still require manual end-to-end checks with the user's account. Command execution fails closed when a supported sandbox is unavailable.

The existing character preview reports “WebGL unavailable” in this environment. Animation and movement regression tests pass, but that does not establish visual 3D rendering on this machine. Floating visibility preferences were left unchanged. The macOS build has no Developer ID signing certificate configured.

## Documentation review

The OpenAI Docs skill informed the provider error classification and speech review. Official references:

- [Spend limits](https://developers.openai.com/api/docs/guides/spend-limits)
- [Rate limits](https://developers.openai.com/api/docs/guides/rate-limits)
- [Speech to text](https://developers.openai.com/api/docs/guides/speech-to-text)

## Build handoff

`npm run package` passed (including a fresh TypeScript check and production bundles). The rebuilt `release/mac-arm64/Athena.app` was restarted successfully. Its Privacy page loaded real persisted preferences and OS capability states through the hardened IPC boundary. No permission switches were changed. Packaging reported nonfatal bundle-size/annotation warnings and skipped Developer ID signing because no certificate is configured. The existing WebGL warning remains visible.
