# Request lifecycle and recovery verification — 2026-11-23

The request lifecycle uses the existing agent loop, tool executor, checkpoint store,
and native runtime integrations. No provider, account, permission, or billing
fallback is introduced.

## Confirmed findings

- The installed Undici connector defaults to a 10,000 ms socket/DNS/TLS connection
  deadline. Athena's separate 60-second response-header watchdog did not configure
  that connector. Custom gateway Agents also omitted the connector deadline.
- A real loopback HTTP test with an 11-second DNS lookup reproduced the old Agent
  failing at ten seconds and the explicitly configured Agent succeeding.
- The reported execution failed before response headers, without Athena's
  watchdog firing. Its saved diagnostics omitted nested SDK/fetch causes. The
  exact historical OS/network failure cannot be recovered from those records;
  the ten-second default is a reproduced architectural defect, not proof of the
  historical network condition. Subsequent millisecond failures are also not
  evidence of slow model reasoning.
- Claude API, Ollama, Copilot, and third-party adapters added whole-task timers
  even when the shared host already owned cancellation. General conversations
  also retained a two-minute task deadline after initialization.
- Recovery classified unknown terminal provider failures as retryable, discarded
  nested transport codes, and conflated subscription exhaustion with rate limits.

## Implementation

`providerTransport.ts` supplies request-local policy using AsyncLocalStorage and
an explicitly configured, request-owned Undici Agent. Concurrent conversations
cannot overwrite each other's policy. Connections are disposed on completion,
cancellation, or failure, including failed retry attempts. Custom gateways keep
their validated DNS pinning, private-network policy, and redirect restrictions.

Default API deadlines are 30 seconds for socket connection, 60 seconds for response
headers, 180 seconds for first response activity, and 120 seconds between actual
response chunks. The existing settings allow bounded overrides; saved preferences
are preserved. Actual SSE heartbeat bytes count as transport activity. No synthetic
activity is generated. These clocks end before local tools execute.

The task host separately bounds provider initialization, then applies its configured
overall task deadline. It passes classified timeout reasons through cancellation
and persists them in checkpoints. Adapters honor an existing host signal instead
of installing a second whole-task deadline.

OpenAI Responses (subscription and API), Anthropic Messages, Ollama HTTP, OpenAI
compatible gateways, and Google SDK inference use the shared transport. Bedrock
uses its documented connection/socket controls with SDK retries disabled so Athena
owns retry accounting. Cursor/Antigravity ACP retain their native RPC, permission,
and activity deadlines; Codex/Copilot keep native sessions. No HTTP inference loop
is placed around a native agent.

Transient recovery remains bounded with cancellable exponential backoff and jitter.
Retry-After is respected by stopping automatic retry rather than retrying early.
Authentication, quota, rate limits, malformed output, and ambiguous terminal
failures are not automatically replayed. OpenAI event recovery retains confirmed
tool outputs and discards unfinished tool calls. Other adapters retry before
consuming a response; partial streams stop with checkpoints available for safe
resume. A request may have consumed provider usage even without a final receipt.

Nested causes are inspected without recording exception messages, endpoint URLs,
credentials, prompts, or tool contents. Diagnostics retain stage, configured
deadline, timing, safe cause code, request identity, selected effort, permission
mode, recovery count, and confirmed operation counts where available.

Same-account model changes and explicitly authorized cross-provider migrations
continue to use the portable checkpoint implementation. Native session identifiers
are not transferred between incompatible runtimes. Replay protection and workspace
authorization remain enforced.

## Files changed for this task

- Transport/recovery: `electron/main/ai/providerTransport.ts`,
  `responseWatchdog.ts`, `requestRecovery.ts`, `streamRecovery.ts`.
- Adapters: `OpenAIProvider.ts`, `contextManager.ts`, `claudeAPI.ts`,
  `OllamaProvider.ts`, `ollamaService.ts`, `CopilotProvider.ts`,
  `thirdPartyInference.ts` in the same directory.
- Host/diagnostics: `AIProvider.ts`, `chatController.ts`,
  `subagentCoordinator.ts`, `shared/context.ts`, `shared/streamDiagnostics.ts`.
- Existing settings control: `src/features/settings/ContextSettings.tsx`.
- Regression tests: `providerTransport.test.ts`, `responseWatchdog.test.ts`,
  `requestRecovery.test.ts`, `streamRecovery.test.ts`, `openAIProvider.test.ts`,
  `contextManager.test.ts`, `claudeAPI.test.ts`, `chatController.test.ts`.

## Verification

- Targeted adapter, native lifecycle, checkpoint migration, replay protection,
  settings, and cancellation suites: **262 tests passed**.
- Real loopback transport plus lifecycle unit tests: **5 passed**, including the
  old ten-second failure and new eleven-second success.
- Final deadline follow-up: **107 tests passed**.
- TypeScript: `npm run typecheck` passed. `git diff --check` passed.
- Final full suite: **2,054 passed, 11 failed, 48 skipped**. Remaining failures
  are in `buildIsolation` (old dev-script assertion), `contextEngine` (required
  local model not running), `outputRecovery` (legacy Auto-effort/message
  expectations), `systemVoiceRollback` (resource-array position assertion), and
  `voiceToolIntegration` (legacy GPT-5.2 reasoning fixture). These failures are
  reported rather than hiding them or changing unrelated runtime behavior.
- A credential-free live request reached OpenAI with HTTP 401 in 1.2 seconds,
  confirming connectivity only. It does not verify inference or plan availability.
- The final macOS Apple Silicon production build passed; host `codesign --verify
  --deep --strict` passed. Athena was quit gracefully and reopened (PID 76855 to
  13568). The backend and dev/mock servers retained PIDs 77555 and 78148. All 31
  conversations remained present, and the paused conversation's 33 messages had
  the same SHA-256 before and after restart. Its active selection was preserved.
- The optional live authenticated chat check was not submitted: the UI reported
  concurrent user interaction, so automation stopped without sending a prompt or
  resuming the user's project task. Live inference after this build is unverified.
- Provider adapter and migration tests use mocks unless explicitly identified as
  the loopback or live app checks. No claim is made that every provider/account was
  tested live, nor that an external network outage can be prevented.

Commands: `npm test`, targeted `npm test -- --run ...`, `npm run typecheck`,
`git diff --check`, and `npm run package`. Logs are in
`/tmp/athena-global-reliability-verified.log`,
`/tmp/athena-global-reliability-final-full.log`, and
`/tmp/athena-global-reliability-package-final.log`.

References: [Undici Client options](https://github.com/nodejs/undici/blob/v6.29.1/docs/docs/api/Client.md)
and [OpenAI streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses).
