# Athena prototype · 0.1

Repository inspection: the workspace contains the original product brief PDF and no existing application or Git repository. Preserve the brief.

Scope: phases 1–2, plus the click panel and state reactions from phase 3. AI providers, voice capture, desktop automation and screen awareness are deliberately deferred.

1. Foundation: Electron + Vite + React + TypeScript, sandboxed preload, validated typed IPC, main-owned settings, tray, shortcuts, packaging.
2. Desktop companion: dedicated transparent window, procedural R3F model, resource-conscious animation, work-area geometry, eased random movement, cursor-based native dragging, pinning, monitor recovery and bounded sizing.
3. Interaction: companion-adjacent mini panel and custom menu, polished control center, appearance/floating/general settings, explicit states, conservative privacy.
4. Validation: typecheck, production build, behavior tests for geometry/settings/states/command routing and settings controls; native launch and visual inspection where the environment permits.

Architecture: `shared` contains validated contracts and pure behavior; Electron owns OS APIs, persistence, windows and motion; the preload exposes only named requests; renderer features consume a synchronized Zustand store; Three.js has no desktop business logic.

Acceptance: verify AC1–AC17 in the README checklist. Packaging a signed/notarized macOS release requires the distributor's Apple credentials and is outside the local prototype.

Implemented: all four passes above. 31 unit/component behavior tests and both native integration tests pass, including transparent pixels, bounds, IPC, settings, restart persistence, and the development CSP nonce required for React Refresh. The packaged macOS ARM64 app launches and renders correctly. Physical multi-monitor and manual pointer/tray interactions remain an explicit QA item; the native UI tool rejected clicks with a stale-window guard.

Timed movement update: extended the existing motion controller with one configurable wander timeout (30 seconds by default), fixed the silent battery blocker, preserved the preference while pinned, and added fake-timer lifecycle and real 30-second native-window movement verification. See [the update notes](WANDERING_UPDATE.md).

Six-position flight update: retained the controller and secure snapshot IPC, replaced arbitrary destinations with six semantic stops, added synchronized native/model flight and settling, and expanded persisted speed to 0.5–10×. All 75 behavior tests and three native integration tests pass, including real 1× and 10× window flights. See [flight update notes](FLIGHT_UPDATE.md).

Random-action update: twelve extensible local model actions, independent main-owned action timer, persistent action switches and interval, selectable wander stops with a nonempty safeguard and one-stop parking. Existing Superman flight remains in the movement controller. Verified 109 behavior tests and four native integration tests; see [idle action notes](IDLE_ACTIONS.md).

Landing refinement: preserve the flight pose through 85%, smoothly stand upright by 94%, and overlay a bounded native-window rise/descent from 88%–100% using the same flight clock. Remove the old post-arrival model bounce. Verified 121 behavior tests and all four desktop scenarios; see [flight update notes](FLIGHT_UPDATE.md).

AI Phase 1 completed: AI settings, typed restricted IPC, main-owned OpenAI connection validation, native Keychain credential persistence, model preference and key replacement/removal. See [Phase 1 notes](AI_PHASE_1.md).

AI Phase 2 implementation: streaming text chat, bounded session history, stop/retry/clear, safe Markdown and companion state integration. Live generation acceptance remains blocked by API credit exhaustion; see [Phase 2 notes](AI_PHASE_2.md).

AI roadmap — current phase: **Phase 3 only**, explicitly authorized after the chat UI update. Implement centralized permission policy, default-off opt-in persistence, real OS status adapters, validated control-only IPC and functional Privacy controls. Remove chat typing outline as requested. No voice, detection, capture, file reads or desktop tools. Verify, package, restart, then stop for Phase 4 approval. See [Phase 3 notes](AI_PHASE_3.md).

Subsequent explicit scope before Phase 4: implement the complete persistent conversation workbench in one task. Inspect/reuse existing main-owned chat and Keychain provider; add local session persistence, session model/effort, secure attachment extraction and vision inputs, authorized bounded repository retrieval, chat controls, tests, packaging and app restart. Supabase is unnecessary for this local desktop architecture. Voice Phase 4 remains unstarted. See [conversation implementation and file inventory](CONVERSATION_SYSTEM.md).
