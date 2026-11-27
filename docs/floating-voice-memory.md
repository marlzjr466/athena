# Floating Athena voice memory

Floating Athena can close a paid GPT-Live connection during silence and continue the discussion on the next wake. The conversation has its own local ID. Each WebRTC connection has a different request ID and must pass the existing voice, microphone, ownership and budget checks.

## What Athena keeps

- Recent user speech and played assistant replies retain their roles. Floating Athena uses GPT-Live’s transcript fragments and local playback activity. Timing is approximate. Incomplete replies can be marked partial, and an unheard fragment can be omitted.
- Older dialogue becomes short local notes about topics, questions, decisions and tasks. Recent verbatim dialogue takes priority. Reconstruction is bounded to avoid resending an entire conversation or paying for an additional summarization call.
- Saying “Remember that I prefer short answers” saves an explicit preference for other voice conversations on the same account. The voice settings also support adding, correcting and removing these notes.
- Codex retains its own task thread during transport recovery. The voice history receives a concise status from verified automation results. A disconnected transport releases its automation permissions. The next request must pass authorization again.

## Review or clear memory

Open **Settings → Voice → GPT-Live 1.1 → Voice conversation memory**. Use **Review history** to inspect the active conversation and saved notes. End the active voice connection before switching, clearing or starting a saved conversation. “Start a new voice conversation” also starts a separate discussion.

The default retention period is seven days after the conversation’s last activity. Options include one day, thirty days and until Athena quits. Expiration is applied when the account's voice history is opened. The local account scope follows Athena's existing OpenAI credential identity. A different key has a separate history.

On systems with secure storage, Electron encrypts the saved text. Without secure storage, new history stays in process memory. A failure to decrypt a previously saved history is surfaced to the user. The voice memory store contains only text and task status. Older Floating Athena conversations whose transcripts were never saved cannot be reconstructed from usage records.

## Reproduction

The opt-in test in `tests/desktop/voiceMemoryLive.spec.ts` launches a signed app in a disposable profile. It supplies a synthetic audio track in place of the physical microphone. Wake detection, Whisper, the floating renderer, GPT-Live, its returned audio track, local checkpoints and decryption run in the app. Playback is muted on the test machine. It exercises immediate recall, forced WebRTC recovery, idle shutdown, app restart, interruption and conversation isolation. It checks the disposable ledger before opening an additional billable session for the isolation check.

Local regression tests cover sparse or delayed captions, interrupted output, native history ordering, preview isolation, account separation, expiration and Codex thread continuity. The live test needs a configured verified credential and explicit authorization for the test budget. GPT-Live documents its startup history format and transcript timing in the [session guide](https://developers.openai.com/api/docs/guides/live-conversations).

## Verified on macOS

The signed build passed the fictional-project test using one disposable profile on November 26, 2026. The local Whisper wake path, GPT-Live WebRTC connection, transcript events, incoming audio playback meter and encrypted history store were all active.

| Acceptance check | Observed result |
| --- | --- |
| Immediate follow-up | GPT-Live said “Blue Moon” in response to a question that omitted the project name. |
| Silence and restart | The test let the connection close, waited two minutes, restarted the signed app and asked for the name. The same conversation ID was restored and the new spoken reply contained “Blue Moon.” The check completed 134 seconds after the idle shutdown. |
| Forced disconnect | Closing the active data channel triggered a new WebRTC connection. The follow-up correctly recalled the project on the original logical conversation. |
| Interruption | During a counting response, synthetic speech caused the floating renderer to mute active playout. The next spoken answer recalled the project. The stored assistant text omitted the unspoken end of the count. |
| Separate conversation | A new conversation had a different ID, empty recent history and empty summary. Its live session and spoken answer omitted the other conversation’s project name. |
| YouTube automation follow-ups | Pending at the user’s request. An automated Codex regression separately checks logical thread reuse, renewed authorization and duplicate prevention. |

Athena’s usage ledger recorded eight closed test transports totaling 196 seconds across all attempts, an estimated $0.1633. The final acceptance run passed in 3.7 minutes. The full regression suite passed 2,525 tests with 61 skipped. Type checking, the production build, strict local code-signature verification and the local WebRTC regression passed.

## Files changed for voice memory

- Session startup and persistence use `electron/main/voice/liveVoice.ts`, `electron/main/voice/voiceMemory.ts` and `shared/liveVoice.ts`.
- Transcript capture, playback and recovery use `src/services/speech/liveHistory.ts`, `src/services/speech/livePeer.ts` and `src/features/voice/HandsFreeAssistant.tsx`.
- The voice memory controls are in `src/features/settings/LiveVoiceSettings.tsx`.
- IPC ownership, task receipts and thread continuity use `electron/main/ipcHandlers.ts`, `electron/main/ai/codexVoiceAutomation.ts` and `shared/handsFree.ts`.
- Regression and acceptance coverage use `tests/voiceMemory.test.ts`, `tests/liveVoice.test.ts`, `tests/aiIPC.test.ts`, `tests/codexVoiceAutomation.test.ts` and `tests/desktop/voiceMemoryLive.spec.ts`.
