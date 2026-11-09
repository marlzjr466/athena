# Meeting Intelligence implementation checkpoint

Implemented 2 November 2026. This is a working meeting foundation with native capture and analysis paths, **not completion of every requested advanced capability or certification of Windows/headset/conferencing compatibility**.

## Architecture and files

Meeting data lives under the existing Electron userData directory in `meetings/<uuid>/`, separate from ordinary Chat and Athena Chat. Metadata uses atomic replacement; transcript events use an append-only JSONL journal. Repeated segment events replace earlier versions during recovery. Truncated journal tails are archived and repaired before further writes. Pending segments and active recordings reopen as interrupted; successfully written audio and transcript remain available. The UI displays the latest 500 segments and 40 answers; exports include the whole loaded session. Sessions are capped at 20,000 segments.

New files:

- `shared/meetings.ts`: strict IPC command schemas, preferences, session types, transcript/export rendering.
- `shared/meetingNotes.ts`: structured note schema, literal evidence validation, owner/deadline checks, user confirmation state.
- `shared/meetingIntegrations.ts`: optional authenticated Google/Microsoft adapter contracts; no live connectors or external mutations.
- `electron/main/meetings/meetingRepository.ts`: independent local storage and recovery.
- `electron/main/meetings/meetingService.ts`: trusted IPC, capture authorization, transcription queue, AI orchestration, panel state, exports.
- `electron/main/meetings/meetingScreenCapture.ts`: pointer-based active-display capture and model-aware image/text context.
- `electron/main/screenCapture/localScreenOCR.ts`, `screenOCR.swift`, `scripts/build-screen-ocr.mjs`: bounded native macOS Vision OCR helper, compiled and included in the macOS app.
- `src/features/meetings/MeetingView.tsx`, `MeetingSettings.tsx`, `meetings.css`: library, settings, templates, transcript, notes, questions, screen context and floating controls.
- `src/features/meetings/meetingCapture.ts`, `useMeetingCapture.ts`, `public/meeting-audio-worklet.js`: continuous audio framing, metering, WAV conversion and independent source lifecycles.
- `tests/meetings.test.ts`, `tests/meetingService.test.ts`, `tests/meetingCaptureLifecycle.test.tsx`, `tests/desktop/meetings.spec.ts`: persistence, consent, audio format, model isolation, grounding and native integration tests.

Modified files:

- `electron/main/main.ts`: existing AI/Whisper adapters, media authorization and lifecycle hookup.
- `electron/main/windowManager.ts`: fourth window in the same Electron process; existing trusted renderer policy.
- `electron/main/rendererProtocol.ts`: correct built-renderer location for native launches outside the packaged bundle.
- `electron/main/tray.ts`: meeting navigation and panel restoration.
- `electron/main/voice/localVoiceServices.ts`: optional meeting language/model/executable selection; ordinary voice defaults unchanged.
- `electron/preload/preload.ts`: typed meeting bridge and events.
- `shared/contracts.ts`: meeting surface type.
- `src/app/App.tsx`, `src/app/ControlCenter.tsx`: route and navigation.
- `package.json`: macOS audio and screen privacy descriptions, native OCR build/package hooks.
- `src/components/ui/CustomSelect.tsx`: opt-in automatic dropdown placement within scroll containers.
- `tests/myAthenaNavigation.test.tsx`: waits for the existing animated route before asserting its heading.

Checkpoint backup: `artifacts/meeting-checkpoints/before-meetings.tgz`. This workspace has no Git repository, so no commit was created.

## Floating panel

Separate sandboxed, isolated BrowserWindow with native drag region, resize, minimum size, compact/expanded dimensions, always-on-top, opacity, minimize, hide, and persisted bounds. Restored bounds are clamped to an available monitor. The ordinary 3D floating companion remains a separate window. The meeting renderer keeps audio processing active when hidden; the main window can close to the tray. Close on the panel means hide and its tooltip states that recording continues.

Microphone, record/pause/resume, stop and input focus remain visible in the bottom toolbar. Secondary actions use a visible overflow menu on narrow windows. Opening the panel never starts capture. Recording requires explicit source selection and consent. Reopening a saved meeting does not resume capture automatically.

## Audio and headphones

Microphone uses getUserMedia with explicit device selection, echo cancellation and noise suppression preferences. System audio uses getDisplayMedia with a main-process display handler issuing native `audio: loopback` only to the trusted meeting frame and only after explicit authorization. The display under the pointer is selected automatically when no legacy source preference exists. The mandatory video stream is never rendered, sampled, or retained by the audio pipeline.

Microphone and system audio remain separate sources, meters, timestamps and recordings. System capture does not depend on the microphone hearing speakers, so it provides the correct architecture for headphones. Native endpoint routing, Bluetooth changes, Teams audio and protected content still need real-device verification. It captures the system mix, not an isolated conferencing process. Speaker playback can produce residual duplicate speech despite microphone echo cancellation. No virtual audio driver is installed.

Each source has an independent capture lifecycle: microphone disconnection or device changes do not restart the system source. A pending system-capture request is rechecked after display enumeration; Stop, source revocation, display changes and a new recording invalidate the old request. Capture tickets are single-use.

The AudioWorklet forms six-second mono PCM buffers, converts to 16 kHz WAV, and never routes captured audio back to audible output. Ended tracks and missing frames produce visible errors. Changing device/source preferences reconnects capture. Failed sources are disabled; the user can explicitly re-enable them. A bounded queue of 12 pending transcription chunks prevents unbounded memory growth. Native export dialogs and model discovery do not block audio storage or Stop. Capture windows report their flush lifecycle so session switching waits for the final audio chunks. Excess chunks remain on disk with an explicit retry state. Disk write failures stop the affected source with a visible warning; unsaved material cannot be guaranteed across a disk failure or renderer crash.

## Local transcription and speakers

Uses Athena's installed whisper.cpp executable and selected GGML model, always locally. Meeting recognition is independent of the analysis provider. Model/executable overrides and language selection (including auto) are per meeting. Windows requires an explicitly installed Whisper executable and model path. Audio is durably written before recognition. Successfully transcribed audio is deleted unless retention is enabled; failed audio remains for retry or explicit deletion. Quiet buffers avoid invoking Whisper. Stored recordings export as a ZIP of separate source WAV clips plus a timestamped transcript, not a falsely renamed continuous file.

Live output is finalized in six-second chunks plus recognition time. Optional partial recognition runs at three seconds when the local queue is idle, then the final result replaces the same segment. Partial text is labeled and excluded from notes until finalized. This is incremental recognition using the local CLI, not token streaming inside Whisper. Word-level timestamping, cross-chunk overlap reconstruction, and voice-based diarization remain unavailable. Source labels and individual transcript segment speakers can be manually corrected; multiple remote voices are not identified. No participant identity is inferred from voice.

Measured locally: the installed multilingual small Whisper model correctly transcribed the generated fixture "We agreed to use mock APIs until the backend is ready. Alex will update the frontend adapter tomorrow." in **2.06 seconds** on CPU, four threads, beam three. This is a synthetic single-clip benchmark, not end-to-end meeting latency or a quality guarantee. The CLI reloads its model per recognition request; a persistent recognition worker is a remaining optimization.

## AI, notes and technical assistance

Reuses Ollama, ChatGPT subscription, OpenAI API and Claude API adapters and account configuration. Local Qwen2.5-Coder 3B is the default selection. No model is silently substituted. Provider/model switches preserve session audio/transcript. Cloud access requires the per-meeting AI and cloud consent toggles and Strict Offline disabled; existing provider billing is used. Audio itself is never sent to the analysis provider. Cursor's native coding execution adapter is deliberately unavailable in meetings until a text-only, tool-free adapter exists.

Analysis uses bounded transcript excerpts and previous notes; it does not promise full long-meeting recall in every request. Requests stream, can be cancelled, and retain partial answers on failure. Automatic notes run at most once a minute after new speech; automatic question preparation is opt-in. Nothing is spoken, sent to a meeting, committed, or written to Jira automatically.

Notes are structured as purpose, topic, decision, proposal, action, question, risk, blocker, technical, dependency and follow-up items. Each requires a literal quote found in a transcript segment. Unmatched quotes reject the update and preserve prior notes. Owners/deadlines absent from the quote become Unassigned/Not specified. Items are marked as AI interpretations until the user confirms them. Quote matching cannot prove that a paraphrase is semantically correct; human review remains necessary. Earlier notes are merged incrementally rather than replaced with an unsupported full-meeting summary. Processed segment IDs prevent a later completed or retried segment from being skipped. Each analysis request is cancellable with a two-minute deadline. A live local Qwen2.5-Coder 3B fixture returned a correctly grounded decision with no invented owner/deadline in about 1.47 seconds; the real response and validation evidence are saved in the checkpoint folder.

Technical and interview templates support questions, code pasted in the text composer, response styles, and practice feedback through the chosen model. Enter sends and Shift+Enter adds a line. Drafts persist. The composer accepts long pasted text (up to 100,000 characters), and long paste creates a removable attachment through the existing Chat AttachmentService in meeting-specific storage. Users can also pick bounded source-code/text files after enabling existing Personal File Access. Interview rehearsal offers explicit local system-voice playback while recording is stopped or paused; starting recording cancels it. It requires an installed local operating-system voice and never speaks automatically. Actual interview assistance must follow the interviewer's rules.

## Screen awareness and coding

Screen Context now has **Analyze active screen**, without a source picker. Explicit AI and screen authorization remain required. A cancellable three-second countdown lets the user switch to their target app. At capture time the display under the pointer is mapped to Electron's `display_id`; Athena does not assume `screen:N` equals the OS display ID. If mapping fails with multiple monitors, capture fails rather than silently selecting another screen. This is pointer-based active-display selection, not detection of the foreground application/window.

Vision models receive the chosen screenshot. Text-only models on macOS receive bounded text recognized locally with Apple's Vision framework, so the default Qwen2.5-Coder 3B can explain visible text and code without pretending to process images. The helper reads image bytes over stdin, keeps images in memory and returns at most 24,000 characters; it does not write screenshots or call online services. Code punctuation and characters can be misread. Empty or failed recognition is reported. A generated code-image fixture was recognized in about 0.8 seconds; it confused a zero with an O, illustrating why review is necessary. Windows text-only OCR is not implemented; Windows screen analysis requires a vision model.

The optional five-minute live session follows the display under the pointer every 30 seconds, skips busy requests, and stops on error, revocation, Safe Mode or meeting changes. Stopping live mode cancels an in-flight screen request. Cloud context still requires separate online authorization. Screenshots are retained only when explicitly enabled. Code/source attachments remain available without screenshot inference, and no meeting feature edits the originals.

Meeting Intelligence is nested under **My Athena** and uses the same page padding as other settings pages. Both page and floating panel use the existing **CustomSelect**, with opt-in automatic menu placement for constrained panels. Recording setup has three short steps; advanced settings are grouped in collapsible sections.

## Capture protection and platform evidence

### Existing-app updates and macOS permission recovery (2 November follow-up)

The extra Spotlight apps were checkpoint bundles (`previous-Athena.app`, `first-meetings-Athena.app`, `pre-usability-Athena.app`). They were unregistered and replaced by validated `.tar.gz` archives. Keep only `release/mac-arm64/Athena.app` launchable; never preserve checkpoints as additional `.app` directories. The current bundle was also archived before this update. No meeting data or conversations were removed.

The permission mismatch was reproduced in the real app: System Settings showed Athena enabled, while a fully restarted Athena reported screen access denied. Previous builds were ad-hoc signed, with a different code-hash designated requirement for each version. Apple's [TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) explains why that invalidates identity-based privacy grants. A stale signing identity is the supported diagnosis, rather than assuming the user forgot to enable the switch.

Local packaging now uses `scripts/sign-local-mac.mjs` through electron-builder's custom signing hook. A persistent self-signed development identity is stored in a dedicated encrypted keychain under `~/Library/Application Support/AthenaBuild/signing`, outside the repository. `npm run setup:local-signing` creates it once and preserves it on repeat runs. The keychain is available to signing temporarily; the prior search list is restored and the signing keychain locked afterward. No certificate trust settings, Gatekeeper settings, or TCC database entries are edited. The signature requires Athena's bundle ID and this certificate, rather than a changing code hash. This is personal development signing, not Developer ID distribution or notarization. Protect the signing directory; replacing its identity will require new OS grants. Apple's [TN2206](https://developer.apple.com/library/archive/technotes/tn2206/_index.html) documents certificate-based identities and local signing.

`meetingScreenPermission.ts` registers screen sources without thumbnails when consent is not yet granted, rechecks macOS, and captures pixels only after approval. A desktop thumbnail alone is not proof of permission because denied capture can contain only wallpaper. Restricted status and cancellation remain enforced. `MeetingScreenAccess.tsx` exposes current status, the exact running app location, settings/reveal actions and a normal restart. Restart is blocked during recording, transcription or analysis and saves the meeting first. Refreshing/requesting permission does not capture screenshots or audio. Existing sessions remain available in history after restart.

This follow-up modifies `package.json`, `package-lock.json`, the two signing scripts, `shared/meetings.ts`, `meetingScreenPermission.ts`, `meetingScreenCapture.ts`, `meetingService.ts`, `MeetingScreenAccess.tsx`, `MeetingView.tsx`, `meetings.css` and their regression tests. Production build/typecheck, 47 focused tests, the desktop integration test (14.9 seconds), and the full suite (1,466 passed, 42 skipped) passed. Automated capture still uses fixture permissions; real OS verification is recorded separately in `artifacts/meeting-checkpoints/permission-fix-deployment.json`.

Real OS follow-up: toggling the stale entry off/on was insufficient. Removing and re-adding the existing Athena app, then fully restarting it, changed the production app's screen permission to **Allowed**. A new `Screen access verification` session completed actual display capture, native local OCR and a response from local Ollama `qwen2.5-coder:3b`. No microphone/system recording was started and no screenshot was retained. The response is not an accuracy benchmark: the display content can change during the countdown, and the model's suggested labels were not validated. Raw screen content was not copied into build artifacts. Only this Athena permission entry was renewed; other apps' permissions were unchanged.

The panel calls BrowserWindow.setContentProtection with the chosen state. UI says "Capture protection requested" and shows platform caveats. It never claims universal invisibility or verified exclusion. Safe Mode and quick hide are available; Athena does not claim to detect external sharing sessions.

Primary references checked during implementation:

- https://www.electronjs.org/docs/latest/api/desktop-capturer — Electron 39+ uses CoreAudio taps for macOS 14.2+; system-audio privacy permission and NSAudioCaptureUsageDescription matter. Older ScreenCaptureKit paths and Electron-version differences need device testing. There is no guaranteed fallback from a failed tap.
- https://www.electronjs.org/docs/latest/api/browser-window — modern macOS ScreenCaptureKit applications may capture a protected window. Windows uses display-affinity APIs; compatible capture paths and OS versions matter.
- https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording — WASAPI loopback captures the rendering endpoint mix, independent of acoustic pickup; protected/exclusive-mode audio and endpoint routing impose limits.

No live Teams, Meet, Zoom, Webex, Slack Huddles, third-party recorder or Windows test was performed. OS screenshot exclusion has not been certified. Playwright's renderer screenshot is a UI test and is not evidence of OS capture exclusion. Native microphone integration used Chromium's synthetic device and a test Whisper executable; OS prompt acceptance was simulated.

## Export and optional integrations

Markdown, TXT, JSON, PDF and DOCX exports include source transcript timestamps and answers. PDF uses Electron's paginated printToPDF with escaped text; DOCX uses the existing ZIP/XML artifact generator and ArtifactService. Audio export streams a valid ZIP of source WAV clips to disk to avoid loading a long recording into memory. Save dialogs provide explicit destination authorization. Delete meeting removes its recordings, notes, transcript and retained screen files; Delete recording removes only stored audio.

The native regression extracts PDF and DOCX text and verifies both notes and transcript content, beyond checking file signatures. PDF extraction normalizes layout whitespace before comparing sentences.

Optional Google/Microsoft integration contracts define authenticated account/scoped access, calendar reads, local follow-up drafts and separately approved document writes. No OAuth connectors, calendar data, external email actions, Google Docs/Drive, Teams/Outlook, OneDrive or SharePoint writes are enabled. No invented meeting metadata is used.

## Verification and remaining work

- TypeScript and production build passed.
- Full regression suite outside the outer tool sandbox: **1,460 passed, 42 skipped**, 169 test files passed and 4 skipped. The restricted run failed existing sandbox/loopback tests; the unrestricted run passed.
- The baseline 25 focused meeting tests passed, covering default-off permissions, storage/recovery, serialized writes, WAV format, path traversal, bounded payloads, question detection, evidence grounding, native capture authorization and revocation races, independent source lifecycles, cloud consent, model-switch preservation, Safe Mode and valid DOCX generation.
- Native meeting integration test passed in an isolated profile: navigation, independent panel, synthetic microphone through AudioWorklet/WAV/CLI with partial and final text, long-paste attachment, pause/resume/stop, structured notes, narrow toolbar overflow, position persistence, requested protection state, Safe Mode, all exports, ordinary online chat via mocked transport, chat history isolation, floating companion still alive, and main-window close-to-tray independence.
- Two legacy desktop tests were attempted and stop at stale expectations: old unconfigured-chat wording and a pre-existing exact preload-method list. They were not represented as passing. The new meeting regression test exercises ordinary chat and the existing floating window alongside meetings.
- Evidence and build logs are in `artifacts/meeting-checkpoints/`; native screenshots/exports are copied there after validation.

Remaining acceptance work: real microphone/system-audio/headphone tests with permissions, Windows installation/run, conferencing/share-source exclusion matrix, actual vision-provider validation, word-level streaming STT, persistent Whisper worker, remote speaker diarization, native local-voice rehearsal checks on Windows, foreground-application detection/automatic source retrieval, Cursor read-only analysis adapter, live authenticated integrations, and prolonged multi-hour/memory-pressure testing. The implementation must not be described as all ten requested phases fully complete.


## Deployment checkpoint

The initial meeting build used ad-hoc signing; the permission-recovery update above replaces it with persistent local certificate signing. The app remains at the original `release/mac-arm64/Athena.app` path. The original and first meeting builds are now compressed checkpoints (`previous-Athena.tar.gz` and `first-meetings-Athena.tar.gz`), not additional launchable apps. `deployment-verified.json` records the initial deployment; `permission-fix-deployment.json` records the current deployment. The app is not Developer-ID signed or notarized for distribution.

Normal Quit closed the old build's windows but left its main process running. That verified old process was terminated with SIGTERM before replacing the bundle; there was no active meeting. This existing shutdown behavior needs further investigation separately from recording recovery.

The package step initially failed under the earlier restricted network environment while downloading Electron. Re-running after the environment allowed network access succeeded. No API keys, live meeting audio or private screen content were used by the verification fixtures.

## Usability and active-screen follow-up

The screen picker was removed from both the main page and floating panel. System audio also defaults to the active display. New regression coverage checks menu nesting/page spacing, custom template selection, automatic display mapping, local text versus vision routing, empty OCR, and cancellation before capture. The native integration uses a generated code image instead of private desktop content to exercise the actual bundled OCR executable through the meeting flow.

The provider handoff now links every prepared attachment to the message through its attachment ID. This fixes previously omitted screen images and pasted/source text across existing AI adapters. The native test confirms OCR text and a pasted code attachment reach the actual Ollama HTTP request and produce the expected fixture answer.

Follow-up verification: full regression suite 1,460 passed / 42 skipped; production build and native meeting integration passed. Evidence uses generated code/speech fixtures and mock model responses, not private desktop content. Native screenshot permission dialogs remain subject to macOS settings.

The usability update was installed at `release/mac-arm64/Athena.app` and is included in the latest permission-recovery build. Its earlier checkpoint is now `pre-usability-Athena.tar.gz`. The packaged OCR helper was tested directly against the generated fixture, existing voice resources were verified present, and the updated My Athena submenu/page were verified in the launched app. See `usability-deployment.json` for that stage's bundle hashes and test results.
