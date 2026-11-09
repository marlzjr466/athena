# Phase 4 — microphone and speech-to-text

## Usage

Enable **Settings → Privacy → Microphone Access**, request macOS microphone consent, and configure OpenAI in **AI**. A denied macOS grant must be changed in System Settings; macOS may require restarting Athena.

In Conversation, hold the microphone button (or **⌘/Ctrl + Shift + A** while the conversation window is focused). Keyboard users can focus the microphone and hold Space or Enter. Release to transcribe. Escape cancels. The first OS consent dialog may cancel the held gesture; hold again after granting consent.

The transcript is appended to the active conversation's composer, preserving an existing draft. Review it and press the normal Send button. Review is deliberate: recognition mistakes must not automatically authorize coding-agent changes. Sending uses the same existing chat service, selected model, effort, attachments, project, permissions, and history as typed input.

## Scope and privacy

- Audio-only `getUserMedia` is allowed only in the trusted control-center main frame during a main-process-authorized recording lease. Camera, screen capture and other renderer permissions remain denied.
- One recording/transcription at a time. Maximum 60 seconds / 4 MiB; transcription timeout 60 seconds, no automatic paid upload retries.
- Audio stays in memory, is sent to OpenAI on release, and is not written to disk or application logs. Transcripts become normal persisted drafts/messages. Provider retention policies still apply.
- OpenAI's recorded-speech `gpt-transcribe` model is independent of the selected chat model. Credentials remain in the main process/OS credential store.
- Switching sessions/configuration, beginning another chat request, disabling microphone permission, leaving chat, hiding the window, cancelling, renderer failure, computer sleep, and quitting invalidate capture. Late audio streams are stopped and stale transcripts discarded. Shutdown also aborts in-flight transcription.
- Microphone use sets Athena to `listening`, faces her forward, and brightens the existing eyes/core. Transcription uses `thinking`. Wandering and idle actions pause and then resume through their existing controllers.
- No wake phrase, background/global recording shortcut, spoken replies, voice selection, or Phase 5 work.

API reference used: [OpenAI file transcription](https://developers.openai.com/api/docs/guides/speech-to-text).

## Files

Created:

- `shared/voice.ts`
- `electron/main/voice/{voiceController,transcriptionService,mediaPolicy}.ts`
- `src/services/speech/voiceCapture.ts`
- `src/features/voice/PushToTalk.tsx`
- `src/styles/voice.css`
- `tests/{voiceController,transcriptionService,voiceCapture}.test.ts`
- `tests/voiceChat.test.tsx`
- `docs/PHASE_4_VOICE.md`

Modified:

- `shared/{contracts,ipcChannels,permissions}.ts`
- `electron/main/{main,ipcHandlers,athenaController}.ts`
- `electron/main/permissions/macOSPermissionAdapter.ts`
- `electron/preload/preload.ts`
- `src/services/desktop.ts`
- `src/features/chat/ChatView.tsx`
- `src/app/ControlCenter.tsx`
- `src/features/athena/CompanionPage.tsx`
- `src/features/settings/{PermissionSettings,SettingsPage}.tsx`
- `src/three/{AthenaAnimations.ts,AthenaModel.tsx}`
- `tests/aiIPC.test.ts`
- `package.json`

No new dependencies, environment variables, database migrations, or saved audio files.

## Validation

Automated tests use fake audio, mocked OpenAI responses, and fake timers. They cover authorization/IPC boundaries, audio-only media policy, permission revocation, session/model isolation, cancellation races, cleanup, duration/size limits, provider error sanitization, and appending a transcript to the normal chat composer/send flow. The existing regression suite and TypeScript check are also run. No ambient microphone recording or paid API request is used for validation. Physical microphone recognition and macOS consent UX require a manual check on the installed app.
