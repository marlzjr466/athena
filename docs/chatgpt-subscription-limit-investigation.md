# ChatGPT subscription limit investigation — 2026-10-19

## Findings and diagnostic uncertainty

- Saved conversation diagnostics reproduce the reported combination: `subscription_sharing_usage_limit_exceeded`, requested model `gpt-5.6-luna`, last observed event `response.metadata`, zero completed tools, and zero recoveries. The affected local account reference is `85d5a7a4`.
- A read-only Keychain audit found that same account selected. Its saved registration, subject, host mapping, and required scopes agree. No duplicate client registration or access token was found among the currently saved accounts. No credentials, email addresses, raw subject identifiers, or token payloads were exported.
- A separate read-only check using OpenAI's public JWKS verified both the retained ID-token and current access-token signatures, issuer, audience, subject, client binding where applicable, and expiration. No inference, refresh, registration, or account switch was performed by this check.
- The conversation explicitly selects `gpt-5.6-luna`; the account default is `gpt-6.1-sol`. The provider sends the conversation model. Luna was not an inferred label for an unrelated runtime model.
- The installed OpenAI SDK throws top-level SSE errors before yielding them to Athena. This explains how `response.metadata` can remain the last observed event even though a later server error ended the request. Athena's existing `response.failed` handling already extracted `response.error`, but discarded response IDs and transport context. Neither path recorded an account/registration reference in the diagnostic itself.
- The user confirms that the 100% meter is ChatGPT app-sharing on a Plus plan, not Codex. The historical failure did not retain the HTTP status, response ID, or quota details. Those values cannot be reconstructed retroactively. The exact exhausted quota, reset time, and the reason for the apparent contradiction remain unknown. No wrong-account credential reuse was established.
- Workspace identity is not exposed by the documented token fields: provider authentication metadata is encrypted. Athena keeps the issued client registration bound to the verified identity, but must not treat email or subject as a workspace name. A comparison with the same account/workspace's app-level Usage settings still requires the user's provider-side view.

## Changes

1. Preserve actual HTTP status and request ID from the streaming response, including HTTP 200 streams that later fail. Never manufacture HTTP 429 from an error code.
2. Preserve allowlisted response ID/model/status and error parameter. Distinguish `response.failed`, a yielded error event, and an SDK-thrown stream error from the last successfully delivered event. Apply transport preservation to context compaction too.
3. Pin a safe account UUID, hashed registration reference, and model-selection source to request diagnostics. Show the short account reference in errors and Settings so users can find the affected saved account without exporting private identity data.
4. Describe an unidentified usage quota explicitly as unknown; do not infer remaining usage, a weekly/five-hour bucket, or reset time. Preserve the connection, stop recovery for this code even without HTTP status, and keep API fallback disabled.
5. Check restored account/registration consistency and signed JWT access-token binding before use; cache successful checks only for that account/token. Preserve opaque OAuth-token compatibility without pretending that opaque contents were independently signature-verified. Reject mismatched signed credentials rather than borrowing another account's token.
6. Serialize initial credential-store loading, resolve active-account defaults after loading, and pin the first request correctly even if Settings has not opened. Reject an unavailable explicit conversation model rather than silently choosing the account default.
7. Check refresh token type and prevent a completed refresh from restoring an account that was removed/reconnected in the meantime. Existing per-account refresh serialization remains intact.
8. Explain conversation versus account-default models in Settings and expose the existing ChatGPT Usage action. Browser navigation does not automatically switch the browser's account.

## Files modified

- `electron/main/ai/chatGPTAuth.ts`
- `electron/main/ai/chatGPTErrors.ts`
- `electron/main/ai/OpenAIProvider.ts`
- `electron/main/ai/responseStreamError.ts`
- `electron/main/ai/streamRecovery.ts`
- `electron/main/ai/contextManager.ts`
- `electron/main/main.ts`
- `shared/streamDiagnostics.ts`
- `src/features/settings/ChatGPTSettings.tsx`
- `tests/chatGPTAuth.test.ts`
- `tests/chatGPTErrors.test.ts`
- `tests/openAIProvider.test.ts`
- `tests/streamRecovery.test.ts`
- `tests/chatGPTSettings.test.tsx`

## Verification

- `npm run typecheck`: passed.
- `npm test -- --run`: 118 test files passed, 3 skipped; 1007 tests passed, 17 skipped.
- Controlled tests cover nested `response.failed.response.error`, SDK-thrown SSE failure after metadata, HTTP 200 plus terminal usage denial, HTTP 429 without retries, redacted exported metadata, cold-start account selection, signed-token mismatches, explicit model selection, simultaneous pinned refresh after account switching, Settings account/model explanation, and Usage navigation.
- Existing tool-loop, context-compaction, account, provider, and application regression tests passed. Live subscription tests remain skipped; no real inference requests were sent to reproduce the limit repeatedly.
- The running packaged app was not rebuilt or restarted for this task. These source changes require a subsequent build/relaunch to affect that packaged instance. No live UI verification of the new Settings text is claimed.

## Official contracts checked

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in): existing loopback OAuth, PKCE, scopes, client registration and ID-token validation match the documented flow.
- [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference): access-token subject, audience, client and grant fields; opaque encrypted authentication metadata.
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions): separate registrations, stable host/client reuse, app-level controls and shared Plus five-hour usage. These facts do not identify this request's exhausted quota.
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery): pause on the usage-limit code and consult Usage; do not infer whole-plan exhaustion or reset time.
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations): HTTP Responses requests use `stream: true`, `store: false`, array input and namespaced tools, omitting unsupported output-limit and persistent-conversation fields.

Provider-side limit enforcement has not been eliminated or bypassed. If the same account/workspace and app limit still show 100%, a new sanitized diagnostic with provider request/response identifiers is needed for provider-side investigation.
