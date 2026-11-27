# Native Codex execution in Athena

Implementation and validation: 2026-11-25. This supersedes the execution-path description in `coding-execution-reliability.md`; that document remains historical evidence.

## Confirmed original differences

The former `Codex app-server through Athena` option launched the real official process, but disabled shell, subagents, browser and computer-use features, started an ephemeral read-only thread for each request, exposed Athena dynamic tools, injected Athena instructions and replayed a reduced local history. Athena's preparation, continuation and execution limits still surrounded the request. Normal subscription conversations could also use Athena's Responses adapter instead. Matching the displayed model did not mean matching the execution harness.

## Implemented boundary

All main ChatGPT subscription conversations now follow Electron → official `codex app-server --listen stdio://` → native Codex thread and turn → ChatGPT subscription. Other main-chat providers retain their adapters. No Athena personality, tool registry, subagent scheduler, automatic continuation or execution watchdog is passed into a native turn. Ordinary text submissions also bypass Athena’s automatic media-intent interception; the explicitly selected dedicated media feature remains separate. Codex discovers its own configuration, applicable AGENTS.md and skills. The separate floating voice planning path remains available; a dictated message submitted to main chat enters that conversation's native thread.

The supported protocol is initialized once per shared process. Version 0.171.0 generated the checked-in protocol types; these are types, not a copied agent implementation. Thread creation is lazy on the first submitted message, so blank chats do not start agent work. Thread IDs and account/cwd identity are saved before submission. Native `clientUserMessageId`, turn IDs, `thread/turns/list` and `thread/items/list` reconcile receipts. Completed operations are not replayed following a timeout, retry or reconnection. Uncertain submissions without a matching receipt stop with an explicit message.

Transport reconnect resumes and reads native history; it does not repeat `turn/start`. Native final turn status determines completion. Streaming text, command output, changes/diffs, reasoning summaries, plans, compaction, native child activity, questions and approval decisions are presented through existing UI. Concurrent questions from child agents are serialized to preserve pending answers. Unsupported server interactions fail explicitly instead of being approved. Normal reasoning text is not exposed beyond summaries.

Each conversation owns an independent native thread. Switching conversations leaves other turns running. `turn/steer` sends a follow-up to the confirmed active turn; `turn/interrupt` targets only that turn. Native subagents remain inside Codex. A child error is displayed without Athena aborting the parent turn; the native parent decides how to recover. Existing completion notifications and voice task completion hooks are retained. A read-only native history browser lists the signed-in account's threads; it deliberately does not take control of threads used by Codex Desktop.

## Configuration and permissions

Account and plan come from `account/read`; available models and efforts come from `model/list`. Selection is checked again before execution. A legacy account route must match the CLI's signed-in account. A mismatch, unavailable model or missing CLI never falls back to another provider or API billing. The CLI manages its own authentication and refresh; Athena does not read or copy Codex Desktop credentials. The spawned process strips inherited OpenAI API key/base URL settings.

Project cwd is the canonical authorized project directory. A normal chat gets a private managed `codex-workspaces/<conversation-id>` directory. The existing composer Access selector controls native policies per conversation:

| Composer selection | Native sandbox | Native approval policy |
|---|---|---|
| Ask Before Changes | workspace-write | on-request |
| Full Access | danger-full-access | never |
| Read Only | read-only | on-request |

Workspace Auto and Advanced retain workspace-write/on-request. With Ask Before Changes, workspace edits do not necessarily prompt: Codex requests approval when required by its policy. Athena does not add a second approval engine. Read Only also forwards native escalation requests instead of automatically declining them.

Full Access requires a distinct explicit confirmation of unrestricted file, command and network access. A historical project-only grant never authorizes this escalation. The grant is saved only for this conversation and is not inherited by new chats. The native path does not modify Athena's global filesystem permission or require project-only scope. OS, organization and server restrictions remain authoritative.

Each submitted turn captures its access setting before asynchronous setup. Changing the composer leaves the current native turn, pending approval and steer operation intact; the next turn receives the new policy. `thread/start` / `thread/resume` set the native sandbox and approval mode, and every new `turn/start` sends the installed schema's typed `sandboxPolicy` and `approvalPolicy`. Reconciliation of already-submitted input and transport reconnect never overrides a running turn's policy.

Returned sandbox and approval settings are compared before submission; native `thread/settings/updated` events are checked too. A rejected/different policy stops submission (or interrupts a changed active turn) and appears as blocked with the actual server restriction. Desired next-turn mode and last verified native policy are displayed separately. `turn/start` in 0.171.0 returns only a turn receipt, so initial verification uses the thread response and subsequent settings notifications, not an invented effective-policy field.

The execution disclosure shows the actual returned thread, model, effort, cwd, sandbox, approval policy and loaded instruction sources. Unsupported saved model selections remain visible until explicitly changed. Usage uses reported native events, deduplicates repeated totals, and does not invent remaining subscription credits.

## Composer access validation (2026-11-25)

The installed Codex 0.171.0 server was tested using the existing ChatGPT subscription, `gpt-6-astra`, high effort, and a disposable workspace. No OpenAI API-key billing was used. The same thread was resumed after stopping/restarting the app-server between each mode:

| Live turn | Returned native policy | Evidence |
|---|---|---|
| Ask Before Changes | workspaceWrite / on-request | One actual escalation approval; fixture written and read back; 16.290 s. |
| Full Access | dangerFullAccess / never | Append and readback; zero approval prompts; 15.189 s. |
| Read Only | readOnly / on-request | Read both fixture files; zero writes; 14.542 s. |

Exactly three native turns were recorded. The sentinel stayed unchanged. Detailed local evidence: `/private/tmp/athena-codex-access-live.json`.

Automated tests cover exact thread and turn fields, confirmation/migration, active-turn configuration snapshots (including asynchronous setup), per-conversation grants, pending approval survival, independent concurrent turns, persistent selection, server rejection/downgrade, unsolicited server-policy changes, and recovery without replay. Server-enforced organization restrictions are fixture-tested; this account did not have an organization policy blocking Full Access. Windows was not physically tested.

The broad regression run passed 2,309 tests (57 skipped). Its initial sandboxed run could not start several native/local-server fixtures; running the same suite with the required host access passed. After the final active-thread and reconnect guards, focused native/provider/UI/legacy-access tests passed; the latest provider suite alone passed 25 tests. Type checking, production build and `git diff --check` passed. Existing chunk-size warnings remain.

The final signed macOS Electron test passed in 1.4 minutes. It exercised the real composer warning, changed Access while a native approval was pending without cancelling the turn, executed an independent Read Only conversation concurrently, approved the original request, verified file contents and the unchanged sentinel, restarted the isolated application, and executed the next turn with verified dangerFullAccess/never and no approval prompts. A layout assertion and screenshots confirm the reasoning selector does not overlap the follow-up button. The existing hover-to-open Select requires hover rather than a click that closes its already-open popup; the initial UI test was corrected accordingly. Local evidence: `/private/tmp/athena-native-ui-evidence.json`, `/private/tmp/athena-codex-access-ui-final.log`, `/private/tmp/athena-codex-access-pending.png`, `/private/tmp/athena-codex-access-verified.png`.

## Safe history migration

Historical Athena messages and attachments remain in place. Their first new native message starts a new persistent Codex thread with an explicit migration notice. Old messages, tool calls and credentials are not silently replayed. The user supplies any old requirements needed in the new thread. Native history is authoritative; Athena retains a presentation cache and refreshes completed turn content from the server. Rewriting earlier native messages is rejected; corrections use a new message. Clearing archives Athena's old association and starts a new thread on next submission, without deleting Codex session files.

## Validation evidence

| Check | Evidence |
|---|---|
| Direct app-server versus Athena adapter | Live, same account, gpt-6-astra, high effort, same fixture cwd and AGENTS.md, identical native sandbox and approval policy. Direct 14.926 s, Athena 15.888 s. Both wrote and read back identical result.txt; sentinel unchanged. This is a small functional comparison, not a general performance benchmark. |
| Duplicate prevention and native restart | Live: same user ID did not add another turn; app-server shutdown/restart resumed the same thread for a read-only follow-up. |
| Two concurrent Electron conversations | Live development and signed Electron: project file-change approval, second normal conversation, independent native threads, actual file contents, sentinel preservation and application restart/history restoration passed. One real native approval was handled. |
| Regression suite | 247 files passed, 6 skipped; 2,295 tests passed, 56 skipped after the routing/recovery/UI fixes. |
| Final focused tests | Native provider and controller: queues, receipt reconciliation, account/cwd checks, failed/interrupted completion, thread-scoped cancellation, disconnect recovery, steer, usage deduplication and concurrent sessions. 15 focused tests passed; see final run log. |
| Build | TypeScript and production Electron/Vite build passed. Existing large renderer chunk warnings remain. |

Evidence logs are in `/private/tmp/athena-native-live.log`, `athena-native-live-evidence.json`, `athena-native-ui-dev.log`, `athena-native-signed-ui.log`, `athena-native-delivery-ui.log`, `athena-native-ui-evidence.json`, `athena-native-regression-delivery.log`, and `athena-native-final-target4.log`. Fixture workspaces are separate temporary directories; production services, databases and project files were not changed. No additional OpenAI API-billed route was selected.

The final delivery package matched the compiled main-process code byte-for-byte; its signed UI test passed in 56.5 seconds.

The initial staging build using a modified development Electron distribution timed out connecting the UI debugger. Rebuilding with the standard Electron distribution passed the signed UI test (59.2 seconds). The old general-chat smoke test also has an outdated exact-three-window assertion; the native UI test waits for the real control window and verifies the rendered composer and native disclosure.

## Limits and distribution

- macOS native harness execution is live-tested. Windows executable discovery is implemented but physically untested here.
- Native user questions, subagent presentation, steering and disconnected-stream fault handling have protocol-fixture coverage. The live comparison did not deliberately spawn a subagent, disconnect a running side-effecting tool or force context compaction; those are not reported as live passes.
- Read-only history display is supported; simultaneous control of a Desktop-owned thread is intentionally not enabled.
- Old history cannot be losslessly converted into a native execution transcript without replay; migration preserves it separately.
- The installed CLI must support the negotiated protocol. Unavailable methods fail visibly; there is no hidden old-engine fallback.
- Official App Server authentication is appropriate for this local installation. It is not authorization for commercial/hosted redistribution. The documented commercial Sign in with ChatGPT path requires approved client registration/eligibility; Athena must obtain that before commercial distribution.

Official references inspected: https://developers.openai.com/codex/app-server (redirects to https://learn.chatgpt.com/docs/app-server), https://developers.openai.com/codex/auth, and https://developers.openai.com/siwc/request-client-id.

## Main implementation files

- `electron/main/ai/CodexAppServerProvider.ts`, `codexCLIService.ts`, `codexProtocol/`: native protocol, events, lifecycle and identity.
- `electron/main/ai/chatController.ts`, `AIProvider.ts`, `conversationRepository.ts`: native dispatch, persistence, concurrent UI callbacks and history.
- `electron/main/main.ts`, `ipcHandlers.ts`, `unifiedAccounts.ts`: routing, canonical cwd, native catalog and IPC.
- `shared/codex.ts`, `shared/chat.ts`, `shared/conversations.ts`, `shared/settings.ts`, preload and renderer desktop contracts: validated settings and messages.
- ChatGPT settings, Codex history/questions, ChatView and ConversationControls: sign-in, permissions, steering and native execution presentation.
- `tests/codexAppServerProvider.test.ts`, `nativeCodexController.test.ts`, `codexAppServer.live.test.ts`, `tests/desktop/nativeCodex.spec.ts`: fixture and actual-runtime validation. Historical provisioning comparison now requires an explicit legacy binary.

## Installed application

After the final signed-build test, the normal release application was restarted (old PID 74305, new PID 18908). The previous bundle remains at `/private/tmp/athena-codex-access-delivery2/Previous-Athena.bundle-backup`. The existing profile was retained. Native UI inspection confirmed the original project, branch, history, selected model and High effort. Its historical Full Access selection correctly shows “confirmation required”; no unrestricted grant was enabled in the user's original conversation and no old task was resubmitted. Select Full Access in the existing Access menu and accept its warning to authorize that new policy, or choose Ask Before Changes / Read Only.

The pre-existing home-screen WebGL-unavailable notice remains outside this access-mode change. The signed update uses Athena's persistent local certificate; public notarization was unavailable in this development environment.
