# Natural action voice

Athena now uses its existing task, local speech controller and audio player for
acknowledgment → authorized action → confirmed response. There is no second
model request, conversation, tool executor, voice provider or message database.

## Behavior

- Intent comes from a validated tool request, not a guess based on user text.
  Acknowledgment begins at that execution boundary, after any approval. Provider
  latency before the first tool call still applies.
- One short, context-specific acknowledgment per task, with varied openings.
  Parallel reads wait behind the same initial speech-start barrier.
- By default the action waits for playback to **start**, not finish. A four-second
  deadline releases the action when speech is slow, missing, or unclaimed. Late
  audio is discarded. A twenty-second lifetime bounds announcement playback.
- Progress describes actual upcoming validated operations. It is at most once
  per 60 seconds by default, with repeated operation categories suppressed. It
  does not expose reasoning or invent findings.
- Final action replies speak after the agent completes. Failures/cancellations
  can produce a brief factual notice; detailed results remain in chat. Casual
  replies retain sentence-level speech without an extra acknowledgment.
- Permissions, current session and cancellation are checked again after the
  speech wait. File version checks and destructive-change approvals remain in
  their existing execution handlers.
- Speech interruption stops audio, not work. Explicit spoken “cancel the current
  task” / “cancel that” commands request cancellation when auto-send is enabled.
  Dictation-only mode does not execute transcribed control commands.
- Voice settings persist locally: Natural Acknowledgments, Speak Before Actions,
  Spoken Progress Updates, Progress Update Frequency, Completion Announcements,
  and Allow Speech Interruption. Auto Speak, mute and Do Not Disturb still apply.

## Files

New: `electron/main/voice/actionNarrator.ts`, `shared/voiceIntent.ts`,
`tests/actionNarrator.test.ts`, `tests/actionVoiceIntegration.test.ts`, this document.

Updated: `shared/localVoice.ts`, `shared/speech.ts`,
`electron/main/voice/speechController.ts`, `electron/main/main.ts`,
`electron/main/ipcHandlers.ts`, `electron/main/ai/{AIProvider,chatController,
chatContextService,agentTools,projectTools,applicationTools,approvedFileTools}.ts`,
`electron/main/desktop/desktopTools.ts`,
`electron/main/screenCapture/screenCaptureTools.ts`,
`src/features/voice/useSpeechOutput.ts`, `src/features/settings/VoiceSettings.tsx`,
`src/features/floating/FloatingAthena.tsx`, `src/features/chat/ChatView.tsx`,
`tests/{speechController,speechOutputHook,desktopTools,screenCaptureTools,
voiceToolIntegration,aiIPC,voiceCapture,voiceChat,projectTools}.test.{ts,tsx}` (existing extensions).

No new dependencies, model downloads, remote services or database migrations.

## Validation

Automated checks exercise speech-start ordering, timeout and late-audio disposal,
approval rejection, permission revocation, cancellation, parallel calls,
deduplication, progress throttling, preference restoration, renderer ownership,
queued completion, and shared local/cloud task identity and timer continuity.
Provider and audio/OS boundaries are mocked in automated integration tests;
hardware microphone quality and real-world synthesis latency require live use.

Final run: 541 tests passed, 2 skipped (60 passed suites, 1 skipped suite).
TypeScript checking, production build and macOS ARM64 packaging passed. The
existing packaged Athena was quit and restarted; the new Voice settings and
their defaults were verified in the running app. No end-to-end microphone/audio
listening evaluation was performed for this update. Packaging remains unsigned
because this Mac has no Developer ID Application signing identity; existing Vite
bundle-size/third-party annotation warnings are non-blocking.
