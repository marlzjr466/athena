# Application automation

## Native Codex computer use

In AI → Automation Permissions → Computer use, select **Codex App Server · ChatGPT** to route floating GPT-Live computer-use requests through the signed-in Codex subscription. GPT-Live continues to handle conversation and audio under the existing voice budget. Existing engine selections persist across upgrades. A separate native Codex thread lives for the active voice session. It uses a read-only, environment-free planning profile and the local computer tools approved in Athena. Voice tasks do not inherit a chat's Full Access setting.

Native ChatGPT coding chats keep their own Codex threads. With Computer use enabled, new threads advertise Athena's tools through the App Server's dynamic tool protocol. Version 0.171.0 accepts these declarations at thread creation. To use the new tools with an older project, start a new chat in that project. The original conversation keeps its thread and history.

Both routes use the existing browser, accessibility, window capture and cursor services. Window sharing identifies the recipient and scope. A voice grant expires with its voice session. Changes of window or target require a fresh check. Project chats can request an exact loopback development preview, subject to approval. The local executor accepts input against a fresh observation and returns the evidence it obtained. A transport retry never replays uncertain computer input.

## Production voice repair — November 25

For a spoken browser search, **Allow for this voice session** authorizes one browser process, window, tab and site. Athena can inspect that tab, enter the words you dictated into a verified search field and submit that query. Follow-up searches within the same scope reuse the grant. Other form submissions, screen sharing and expanding the scope have separate approval checks. Stopping automation or ending voice clears the search grant.

**Allow routine browser searches** in Automation Permissions applies to direct search requests in Codex chat and Floating Athena voice. When enabled, Athena can use the current tab, open a new tab if requested, or navigate to the site you name. It shares structured controls from that tab with Codex, enters your search words into a verified search field, and submits the query without a popup. On supported browsers, a follow-up voice search can use the same authorized tab while another app has focus. You can turn the permission off at any time. Screenshots, external messages and other sensitive actions require separate approval.

The earlier isolated checks below are not acceptance evidence for the user's continuous production GPT-Live workflow. That workflow requires interactive verification in the signed production app, using the existing Chrome profile, plus native-app and Athena actions.

Confirmed code defects: the status only reported a CDP/Playwright connection, hiding the native-browser path; the browser intent guard rejected resolved result/playback commands; unsupported native page operations terminated before reaching visual recovery; Live consumed “Resume” even without an active task; fast native actions could hide feedback before its first painted frame. Exact errors for older failed production actions cannot be reconstructed from the old audit format, which recorded only status and duration.

Repairs retain the existing executor. Only a typed, pre-input observation failure can request visual recovery. Permission denials and uncertain input never trigger it. Playback can use a unique native Play/Pause control and verifies its changed state. Window screenshots remain scoped to an explicitly approved task/window. Pointer validation compares the target region rather than unrelated animated pixels, while rechecking window identity and permissions. Final visual evidence describes the post-action observation rather than requiring a video frame to remain byte-identical. Approval focus restoration is limited to the original window when Athena's own sheet took focus.

History now includes bounded diagnostic metadata and sanitized failure reasons; old entries explicitly lack those details. The capability check distinguishes local checks from untested voice, capture, visual inference and input. It does not label the whole computer-use system verified. No screenshot, prompt or raw tool output is stored in this audit.

Settings → AI → Computer use selects the engine. OpenAI Automation is the default for complex instructions. Simple commands continue to use their registered local actions. Chat and GPT-Live use the same action registry, permissions and desktop services. The selected conversation model remains available for ordinary chat and for compatible native planning.

## Execution

| Route | Execution and verification |
| --- | --- |
| Managed planning | The Agents API returns one typed decision per turn. Athena executes approved actions locally, checks the result and includes the verified receipt in the next turn. The planner can request a tool’s schema as needed. |
| Visual interaction | The Responses computer tool receives the approved application window. Athena verifies the foreground process, window identity, screenshot and input permissions before acting. It observes the result again before reporting completion. |
| Native fallback | A compatible configured conversation model or local companion model plans with the same tools. Missing credentials, exhausted budgets and eligible service errors trigger the configured fallback. A permission denial or an uncertain input stops execution. |
| Recovery | The journal records pending input before dispatch. It saves verified receipts and, when available, encrypts resumable task context using OS secure storage. “Resume my last automation” rechecks the target in the originating conversation. Interrupted visual input requires a fresh inspection of the same window and approval of further input. |

Pause, resume and stop are available on an active task. A pause holds the next input. An operation already delivered to another application can still take effect. The progress display shows the active engine, application when known, elapsed time, verified steps and OpenAI requests.

Before cloud planning, Athena asks to share the instruction and relevant tool results. Sharing an application window and issuing visual input require separate approval. The monthly request cap applies before each managed or visual request. The optional USD threshold uses reported token estimates. An individual request can cross that threshold, and unreported usage holds later OpenAI requests when the threshold is set.

## Optional self-hosted executor

Select **Self-hosted sandbox** and **Prepare executor** to obtain the session’s environment ID and remote URL. Provision an isolated executor with an empty `/workspace`, no host mounts, and an environment-scoped key supplied as `CODEX_API_KEY` inside that sandbox. Use the returned URL unchanged.

```sh
codex exec-server --remote "<remote URL>" --environment-id "<environment ID>"
```

**Check connection** reports whether the managed session received its executor connection. Desktop actions continue through Athena’s local permission checks. [OpenAI self-hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)

## Verification on the development Mac

### Production voice repair, November 25

The continuous microphone acceptance test is **not passed**. The user reported no visible indicator and then clarified that requesting a new tab only produced an “already open” response. The production audit recorded two application-opening actions, not a tab creation or search. Those older entries did not retain underlying errors, so their precise failure messages cannot be recovered from history.

A confirmed routing defect allowed the fallback matcher to reduce any unrecognized request containing “open” and “Chrome” to application activation. It now matches only a standalone application request; other objectives retain their full instructions for the existing planner. Regression tests also cover full browser names with new-tab requests.

Additional repairs distinguish native browser availability from a DOM connection, route unsupported pre-input observations to the existing authorized visual executor, and verify native playback by accessibility-control transitions. Bare “resume” can reach playback when no automation task is paused. Visual freshness checks retain window and foreground validation while avoiding whole-window byte equality for unrelated animated content. Overlay diagnostics record actual failures, await painting before input, and place activity feedback on the target display where known. API actions without a resolved element show activity, not a fabricated cursor target.

The signed production app reported Screen Capture and Accessibility allowed, and its production native helper observed the existing Chrome window. Vision fallback was enabled with the user's authorization. The second repair's seven focused unit suites passed all 77 tests, and type checking passed. These tests are not substitutes for the remaining continuous floating GPT-Live acceptance workflow, actual cursor visibility, or Windows and multi-monitor hardware validation.

The installed OpenAI SDK specifies transcript fragments in delivery order. Athena had sorted overlapping fragments by timestamps; it now preserves delivery order, with an added regression test. The two voice suites passed 16 tests after that change. The final build succeeded, its main program, overlay HTML and 72 renderer code files matched the packaged archive, and Athena plus four helper apps passed signing verification. The production app restarted from PID 36763 to PID 70142 and its main interface loaded. The user has been asked to retry tab creation through floating GPT-Live; that acceptance result remains pending.

Follow-up production evidence: the user confirmed the new tab and cyan activity indicator appeared. Task `adb2cb2b-266c-4cbd-a4c3-6ef682f4ad05` recorded `athena.browser.action`, intent `new-tab`, completed in 647 ms, with a painted activity receipt. Read-only UI inspection showed one existing Chrome window with seven tabs, compared with six before the command.

The next spoken navigation failed verification: task `43e2e4a7-94a2-4be7-b584-b32cf3769f78` reported “The address was submitted. Navigation could not be verified” after 2,470 ms. Read-only UI inspection showed YouTube loaded, while the address bar displayed `youtube.com`. The native verifier incorrectly compared that elided display against `https://www.youtube.com/`. The repair verifies the observed document URL and maintains exact host/scheme/query matching, with a bounded observation interval and no navigation replay. Search, playback, scoped screen awareness and the target cursor remain awaiting the continuous production test.

The navigation repair compiled successfully; the two desktop/browser unit suites passed 33 tests. A real-browser regression case for an elided `www` address was added, but has not been run in this repair session. The production bundle and four helper apps passed signing verification, the packaged main program matched the build, and Athena restarted from PID 70142 to PID 86379 for the user's next live attempt.

The user subsequently confirmed YouTube and search results appeared, but only after rephrasing. Production task `f6d53e35-e2b8-488b-9afa-9adadc03d6a2` completed its browser search navigation in 1,530 ms. The unsuccessful natural request was “search relaxing music.” Both the computer-use classifier and current-browser visual handoff incorrectly required “search for”; the omitted preposition sent the request through the generic chat/tool route, which rejected `browser.openUrl` under its literal navigation guard. A shared search-intent recognizer now handles both forms and common polite prefixes. It retains fresh foreground validation and existing permissions; it excludes explanation, negation and explicit local-file/project discovery. Browser diagnostics now also retain the validated operation enum, without URLs or query text. Three focused suites passed 48 tests after this fix. Natural follow-up search and subsequent playback still require production voice acceptance.

That repair was built and signed with the existing certificate; four helper apps were verified. Packaged main and overlay files matched the build. The production copy restarted from PID 86379 to PID 2806 and reached “Companion ready.” The current interactive check asks the user to repeat “Search relaxing music” on the foreground YouTube tab, with the ordinary scoped sharing prompt if required.

### Earlier isolated evidence

| Scope | Evidence |
| --- | --- |
| Live OpenAI visual inference | GPT-6.2 Sol clicked **Show locker** once in a disposable Electron window. The model read **Locker 47**, which matched the fixture’s DOM. The successful run took 6.847 seconds and used three requests, estimated at $0.007918 from reported tokens. The fixture supplied its own pixels and input. |
| Live managed environment allocation | Both configured models returned restricted environment invitations. Both test sessions were deleted. An environment-scoped executor credential was unavailable. |
| Managed planner stream | The installed OpenAI SDK consumed fixture events for a typed decision, token usage, exhausted credits and a safety denial. Live managed planning inference was left untested because the session interface exposed no per-turn cost cap for the authorized $0.20 test. |
| Real local fallback | With a zero OpenAI request budget, the installed Ollama Qwen 2.5 3B model planned against a disposable Athena conversation, invoked its status action and returned the real result. The OpenAI request count stayed at zero. |
| Chat and settings | A normal chat instruction opened the AI settings page. The signed app saved the selected automation engine and monthly request budget and restored both on its next launch using the same disposable profile. |
| Chrome and desktop Accessibility | A real Chrome profile with two windows opened a tab in the intended window. Athena restored a minimized window and rejected a stale target. The signed floating app highlighted and clicked an external accessible control, then inspected a disposable TextEdit document. |
| Browser playback | The installed app ran its voice action registry and packaged browser driver. In a separate visible browser, the Playwright adapter opened live YouTube search results for Unreal Engine tutorials, selected the second video, and verified playback and pause. |
| Voice transport | A local WebRTC peer exercised delegation and interruption with synthetic audio. Interruption to silence measured 117 ms in that run. Cloud microphone latency was outside this test. |
| Platform limits | The signed Mac app reported Accessibility granted and Screen Recording denied. The OS-level visual pointer test skipped before capture. Windows adapter coverage used fixtures. Physical Windows, mixed-DPI displays and cross-monitor visual input remain unverified. |

The production build passed type checking. The eight focused test files recorded 57 passes and three opt-in skips. The full unit suite recorded 2,270 passes, 56 skips and six failures also present in the earlier baseline. These cover three Full Access UI assertions, one development-build isolation assertion and two output-recovery assertions. The installed bundle passed deep signature verification, and its packaged main program matched the tested build byte for byte.

[Routing and recovery tests](../tests/applicationAutomation.test.ts) · [SDK protocol tests](../tests/openAIAutomationTransport.test.ts) · [Window driver tests](../tests/approvedWindowDriver.test.ts) · [Packaged settings and local inference](../tests/desktop/applicationAutomationSettings.spec.ts) · [Live visual probe](../tests/desktop/openAIAutomation.spec.ts)

The implementation uses the documented managed session and manual computer-tool protocols. [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) · [Computer use](https://developers.openai.com/api/docs/guides/tools-computer-use) · [Custom computer integrations](https://developers.openai.com/api/docs/guides/tools-computer-use-integration) · [Computer drivers](https://developers.openai.com/api/docs/guides/tools-computer-use-sdk-drivers)
