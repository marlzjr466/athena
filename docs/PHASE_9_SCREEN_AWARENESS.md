# Phase 9 — On-demand screen capture and awareness

Implemented `capture_screen` and `read_screen` through the existing typed main-process tool system. Both use one approved snapshot per request, not a recording loop. A vision/function-capable selected model receives actual image input in its function result and answers through the existing streamed conversation. No new agent or renderer filesystem/OS API is exposed.

## Use

1. In Settings → Privacy, enable Screen Capture & Awareness.
2. Request macOS access. If macOS does not prompt, enable Athena in System Settings → Privacy & Security → Screen & System Audio Recording, then restart Athena if required.
3. Select a vision- and tool-capable model and ask, for example, “What is on my screen?”
4. Review the in-chat capture approval. It identifies all connected displays and the OpenAI destination. Hide sensitive content before approving.
5. Athena captures one snapshot of each approved connected display and uses it for that request. A later request requires fresh approval and capture.

## Privacy and bounds

- Permission preference, actual macOS consent, conversation identity, model capabilities, and per-request approval all apply. Read Only does not bypass screen approval; neither do automatic editing modes.
- Permission requests enumerate screen sources with zero-sized thumbnails; they do not request screenshot pixels or send anything to OpenAI.
- Capture uses Electron main-process `desktopCapturer`, not a video/audio stream. No continuous recording, clicks, typing or screen automation is implemented.
- This version captures **all connected displays**, explicitly covered by approval, up to four displays. There is no single-window, region or individual-monitor picker yet.
- Display topology is checked before and after capture. Unknown, missing, empty or oversized images fail closed.
- Each image is bounded to 1,600 pixels on its longest side and 2 MiB of JPEG data. Capture has a 10-second deadline. A cancelled native request may finish internally, but its result is discarded and overlapping captures are blocked.
- Screenshots stay in request-local memory. Only metadata goes to activity. Screenshots and opaque provider checkpoints derived from them are not saved in chat, logs, attachments or cloud storage. The written AI answer remains in history; OpenAI’s retention policies apply to approved requests.
- Screenshot output is deduplicated during the tool loop and can be reused after in-memory context compaction without another capture.
- Access is checked before capture, after approval/capture, at image conversion, and before API/compaction requests. Turning the switch off cancels the active conversation request. Already transmitted images cannot be recalled.
- Visible text is treated as untrusted evidence, not executable instructions. Athena is instructed to acknowledge unreadable/obscured content and never infer visual access from a permission alone.

## Files

Created:

- `electron/main/screenCapture/screenCapturePlatform.ts`
- `electron/main/screenCapture/macOSScreenCapture.ts`
- `electron/main/screenCapture/screenCaptureTools.ts`
- `tests/screenCaptureTools.test.ts`
- `tests/macOSScreenCapture.test.ts`
- `tests/screenConversation.test.ts`
- `docs/PHASE_9_SCREEN_AWARENESS.md`

Modified:

- `electron/main/main.ts`
- `electron/main/ipcHandlers.ts`
- `electron/main/permissions/macOSPermissionAdapter.ts`
- `electron/main/ai/AIProvider.ts`
- `electron/main/ai/OpenAIProvider.ts`
- `electron/main/ai/applicationTools.ts`
- `electron/main/ai/chatContextService.ts`
- `electron/main/ai/contextManager.ts`
- `shared/permissions.ts`
- `tests/macOSPermissionAdapter.test.ts`

## Verification

Full Vitest suite: 451 passed, one skipped across 49 files. TypeScript passed. Coverage includes approval/denial, disabled and revoked access, cancellation, monitor changes, image-size limits, native timeout, no overlapping/repeated captures, actual multimodal request construction, timer continuity through output recovery, unavailable models, and non-persistence of screenshot/checkpoint content. Existing voice, desktop, repository and movement tests remain passing.

Tests mock Electron capture and OpenAI responses. No real desktop screenshots were captured or transmitted during development, no permission switches were changed, and no API credits were used for live screen analysis. Native permission granting and live model interpretation remain manual verification steps. Protected OS content may be blank; reduced screenshots may make small text unreadable. This is macOS-only and the development package remains unsigned without a Developer ID certificate.

No new dependencies, migrations or environment variables are required. Phase 10 is not included.

## References

The OpenAI Docs skill guided image encoding and model-capability handling using [OpenAI images and vision](https://developers.openai.com/api/docs/guides/images-vision) and the installed Responses SDK’s typed multimodal function output. [Electron desktopCapturer documentation](https://www.electronjs.org/docs/latest/api/desktop-capturer) documents main-process capture, thumbnail sizing and macOS consent requirements.
