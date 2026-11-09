# GitHub Copilot subscription integration

Implementation status (2026-11-06): integration added; authenticated end-to-end acceptance is pending. Do not interpret runtime startup or mock tests as a successful subscription conversation.

## Official interfaces

- https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate
- https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth
- https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- https://github.com/github/copilot-sdk

Pinned SDK: `@github/copilot-sdk` 1.0.28. Bundled official runtime: 1.0.105, protocol 3. No private inference endpoints. Runtime is spawned over stdio; platform runtime resources are unpacked for Electron distribution.

## Authentication

Settings → AI → GitHub Copilot Subscription.

Register an OAuth App with GitHub and enable device flow. Supply its public Client ID in Athena. Athena requests `read:user`, displays GitHub's user code, and polls only when requested, enforcing the returned polling interval. Identity is validated using GitHub's official `/user` API before storage. Device authorization has no redirect callback/state or PKCE exchange. No client secret is embedded. Browser authorization-code login inside Athena is not implemented; the device flow opens GitHub's official browser authorization page. OAuth App registration must be completed by the owner.

Account metadata and tokens live in OS credential storage via the existing keyring dependency, scoped to Athena's profile. Renderer IPC returns only public account metadata and the user-facing device code. Each OAuth account has its own SDK client, explicit `gitHubToken`, `useLoggedInUser: false`, and isolated runtime directory. Disable/remove stops that account's clients. Selection affects subsequent requests; no automatic account rotation. Revoked/expired tokens require reconnect; refresh-token renewal is not implemented.

Original CLI implementation (superseded by the sign-in update below): authenticate with official `copilot login` outside Athena (browser or device flow), then Connect authenticated CLI. The SDK's documented signed-in-user authentication checks identity; Athena never reads CLI credential storage. CLI bindings are not independent credentials: external account changes cause a fail-closed identity mismatch. Use OAuth for independently selectable accounts. Automatic CLI installation/login launch, CLI executable discovery/status and global CLI logout are not implemented. Verify whether your installed CLI credentials are accessible to the bundled SDK runtime; no authenticated CLI test has passed yet.

## Chat, tools and billing

Provider registration uses existing Settings, secure control-center IPC, conversation history, model controls and streaming renderer. Models and supported effort levels come from `listModels`; disabled/unconfigured models are excluded. Athena's existing effort enum exposes auto/low/medium/high/xhigh only; SDK-only levels are not advertised. No hardcoded model IDs.

SDK `mode: empty`, explicit custom-tool allowlist, built-in/MCP exclusions and denied native permission handler prevent SDK host tools from bypassing Athena. Only prefixed Athena custom tools invoke the existing authorized tool executor. Existing project, filesystem, desktop and remembered-permission checks remain authoritative. SDK repository file hooks and automatic infinite-session compaction are disabled. Cancellation aborts/disconnects the SDK session. Conversation history stays in Athena; each request creates a fresh SDK session with that history, rather than retaining opaque resumable SDK sessions. Tool-call count and request timeout are bounded; oversized prompts fail rather than silently truncating at the adapter boundary. Existing upstream attachment retrieval still applies and exposes its notices.

Subscription clients exclude BYOK/provider configuration and runtime-injection environment variables. OAuth clients also remove ambient GitHub tokens. CLI clients preserve official GitHub-token environment priority and verify identity. There is no cloud API fallback and no automatic OpenAI built-in search invocation for Copilot requests. Explicit separately configured non-Copilot web tools retain their own settings. Plan eligibility and model billing multipliers apply. Usage balances are not shown because they have not been verified. Current generation errors are sanitized; fine-grained quota/network error classification remains limited.

## Remaining acceptance work

- Actual OAuth/CLI authentication, account switching and token revocation against eligible subscriptions.
- Real dynamic catalog, streaming conversation, project edits, terminal and desktop tasks through approvals, usage-limit errors, and generation cancellation.
- Copilot image/PDF attachments are explicitly rejected; text uses existing attachment preparation.
- Independent sub-agents are blocked: SDK request/token budget enforcement is not yet integrated.
- Existing chat dictation/auto-speak remains on the shared pipeline. Floating Athena is still intentionally local under the existing architecture; selecting this online provider does not switch its model. Copilot-powered floating/hands-free conversation needs an explicit architecture extension and is not implemented.
- Windows runtime/credential behavior has not been executed on a Windows machine.
- OAuth browser callback flow, refresh token renewal, and in-app CLI login/logout controls remain absent.

## Verification

16 mocked service/provider tests cover environment filtering, account persistence and identity checks, token redaction, device authorization, IPC validation, disabled accounts, streaming, allowed tools, cancellation and usage failures. Existing chat/context/model-control regressions are run separately.

Real Node runtime smoke check on this Apple Silicon Mac: startup succeeded, version 1.0.105 / protocol 3; unauthenticated (intentionally isolated). Electron test exercises Settings and the same unauthenticated runtime. No paid inference request was sent. Authenticated generation must be verified before calling the overall feature complete.

### Recorded checks

- Typecheck and production build: passed.
- 60 tests across Copilot, ChatController, verification gates, OpenAI search context, and Cursor conversation controls: passed.
- Electron settings + real unauthenticated runtime test: passed from the development build and signed macOS package.
- Packaged runtime regression found during testing: SDK attempted `chmod` through `app.asar` and failed with `ENOTDIR`. Fixed using documented `RuntimeConnection.forStdio({path})` pointing at the unpacked official runtime. Retested successfully.
- No authenticated model generation, Windows execution, or Copilot voice conversation is reported as passed.

### Files changed

`package.json`, `package-lock.json`; `shared/ai.ts`, `shared/settings.ts`, `shared/contracts.ts`, `shared/ipcChannels.ts`, `shared/copilot.ts`; `electron/preload/preload.ts`; `electron/main/main.ts`, `electron/main/ipcHandlers.ts`; `electron/main/ai/copilotService.ts`, `electron/main/ai/CopilotProvider.ts`, `electron/main/ai/chatContextService.ts`; `src/services/desktop.ts`; `src/features/settings/AISettings.tsx`, `src/features/settings/CopilotSettings.tsx`; `tests/copilot.test.ts`, `tests/desktop/copilot.spec.ts`; this document.


## CLI sign-in experience update (2026-11-06)

Settings now prominently offers **Sign in with GitHub (Browser)**, **Sign in with GitHub (Device Code)**, and **Connect Existing Copilot CLI**. Independent OAuth is collapsed under Advanced; CLI sign-in never needs Athena's Client ID.

The main process discovers an installed executable, checks `--version` and `login --help`, and spawns the documented `login --web-flow` or `login --device-code` argument array without a shell. A bounded transient output buffer extracts only the documented user code; raw authentication output is not logged or returned. The CLI opens the browser itself. Device codes have copy/open controls. Status polling runs only while login is pending and stops on completion/unmount; the main-process login continues across navigation. Cancel and a five-minute deadline terminate the owned login process. Nonzero exits, unsupported versions, missing installations, and failed identity checks do not connect an account.

On successful exit Athena validates SDK `getAuthStatus()` identity and requires signed-in-user authentication before saving the CLI binding. Interactive CLI clients use `mode: "copilot-cli"` and the standard CLI home. `mode: "empty"` forces `COPILOT_DISABLE_KEYTAR`, and official `copilot login` stores the user in the OS keychain, so empty mode reports a completed login as signed out. OAuth clients retain `mode: "empty"`, independent runtime directories, and explicit tokens. Session creation still disables host skills, git, memory, config discovery, and built-in/MCP tools for every Copilot request. Ambient GitHub tokens are excluded for interactive CLI bindings to avoid overriding the user who just signed in; BYOK remains excluded.

**Account management:** GitHub documents `/user`, `/user list`, `/user switch`, `/logout` as interactive slash commands. Athena does not parse private credential/config files or invent JSON account-list commands. On macOS, Manage CLI accounts in Terminal opens the installed CLI with instructions. Athena generation is blocked during that workflow; exit the CLI and reconnect to revalidate the chosen identity. On Windows, explicit manual terminal instructions are supplied; automated terminal opening is not implemented. Listed Athena accounts are verified saved bindings, not a claim to enumerate all CLI accounts. Login and account mutations are blocked while an Athena Copilot generation holds its request lease. External CLI changes cannot be prevented; identity is checked before each request. No automatic account rotation.

Installed and checked official CLI 1.0.106 on this Mac. Real Electron device-code initiation, code rendering, and cancellation passed without authorizing GitHub or performing inference. Browser flow argv, success/failure, timeout, cancellation, late events and executable discovery have mock coverage. Real browser authorization completion, account switching, model discovery with an eligible account, subscription inference and real quota errors remain unverified. Existing mock provider tests cover streaming, model filtering and quota failures. Windows execution remains unverified.

Additional changed files: `electron/main/ai/copilotCLIAuth.ts`, `tests/copilotCLIAuth.test.ts`. Updated service, provider request lease, shared contract, settings, main-process shutdown, existing tests and this report. No other provider or voice engine was changed.

Final sign-in update verification: 62 automated tests across four suites passed; typecheck and production build passed. A real Electron test initiated `copilot login --device-code`, rendered the actual one-time code, and cancelled the owned process successfully. No account was authorized and no subscription inference request was made by this test. Official CLI installation was authorized separately and is at `/opt/homebrew/bin/copilot` (1.0.106).
