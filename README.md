# ATHENA

**Your intelligent companion, alive on your desktop.**

A macOS-first Electron desktop companion with a procedural Three.js character, a genuinely transparent floating window, and a polished local control center. This implements the first prototype: phases 1–2 and the interaction portion of phase 3.

The separate AI roadmap is now at **AI Phase 3: Permission system foundation**. See [Phase 3 permissions](docs/AI_PHASE_3.md), [Phase 2 text chat](docs/AI_PHASE_2.md) and [Phase 1 configuration](docs/AI_PHASE_1.md). Phase 4 voice input requires explicit user authorization.

The requested [persistent conversation workbench](docs/CONVERSATION_SYSTEM.md) adds multiple saved conversations, session-specific models/reasoning, attachments, image understanding and read-only project context before Phase 4. It uses private local storage, not Supabase; no new environment variables are required.

## Run

Requires macOS and Node.js 22.13+ (Node 22 LTS recommended).

```sh
npm ci
npm run dev
```

To run the production build:

```sh
npm run build
npm run preview
```

To create a local macOS application:

```sh
npm run package
```

The resulting `release/mac-arm64/Athena.app` (or `release/mac/Athena.app` on Intel) can be opened directly. `npm run dist:mac` creates distributable archives. Public distribution requires your Apple signing and notarization credentials; they are not included in this project. Launch at login is only available in the packaged app.

## Meet Athena

- Click the floating character for a companion-adjacent mini panel. It closes on blur, Escape, or one minute of inactivity.
- Drag the character to move her. Movement stays within the usable display area and resumes after 30 seconds by default.
- Right-click for the custom context menu, pinning, size presets, monitor transfer, settings, hide, and quit.
- Use **My companion** for quick controls, **Appearance** for size/glow/particles/quality, and **Floating & movement** for monitor and movement preferences.
- Close the control center to keep Athena in the system tray. Quit explicitly from the tray or application menu.
- `Cmd+Shift+Space` opens the control center. `Cmd+Shift+H` shows/hides Athena. Both shortcuts are configurable.
- The mini panel understands exact local commands such as “stay here”, “resume floating”, “make yourself smaller”, “make yourself bigger”, “hide”, and “open settings”.

Size is constrained to 80–400 pixels; default 180. **Free to Wander waits 30 seconds by default**, then flies to one of six stops: top left/right, middle left/right, or bottom left/right. It excludes the current stop and avoids immediately returning to the previous stop. Set **Floating & movement → Movement interval** to any whole number from 10–300 seconds, and **Movement speed** from 0.5×–10× (default 1×). Both persist and take effect immediately. A new countdown begins only after flight and settling finish, after a drag, or after the mini panel closes. Manual drops remain where you place them until the next scheduled flight.

Flight uses cubic deceleration along a wide, inward Bezier sweep. The control offset scales with travel distance and available display space, up to 700px, producing a broad early arc that tightens into a straight final approach without circling in place. The main process calculates and shares the exact control points with the renderer. Athena raises her arms and aligns her head-to-feet axis with the curve tangent, becoming nearly horizontal on side-to-side flights. A 360° roll around that aligned body axis finishes during the first half, while her head keeps leading the motion. She holds that pose through 85%, then smoothly stands upright by 94%. The actual desktop window rises slightly from 88% to a peak at 95%, then gently descends into the exact named stop at 100%. The rise is 18px at default size, scaled to 8–24px and limited by available overhead space; it may use edge padding but never leaves the work area. There is no second model-only bounce after arrival. Native duration remains distance-based, divided by `movementSpeed`, and clamped to 250–6000ms, followed by the existing 200–500ms quiet stabilization before wandering resumes. Model and native movement run briefly at 60 fps, including battery mode, then return to idle quality. All control points remain inside the current work area, accounting for window dimensions and edge padding.

**Floating & movement → Wander positions** lets you enable each of the six stops. At least one must remain enabled. With a single stop, Athena travels there and stays without scheduling repeat flights. Disabling a destination during a flight cancels that flight and restarts destination selection; manual dragging and pinning still take precedence.

**Random Actions** defaults on with a 30-second interval, configurable from 10–300 seconds. Individually enable Sitting, Slight Jump, Wave / Hello, Turn Around, Front Flip, Back Flip, Small Spin, Look Around, Stretch, Hover Bounce, Bow and Happy Pose. All may be disabled. Actions start only while idle at an enabled stop, avoid immediate repeats when alternatives exist, and animate only the model inside the existing window. The action countdown is independent of wandering and restarts after completion or resumed eligibility. A due flight lets a running action finish (at most 3.2 seconds), then leaves immediately. Dragging, hiding, opening the mini panel, disabling an action, task activity, DND and reduced motion cancel it safely. Pinned Athena can still act if she is at an enabled stop. Every action and position preference persists locally.

Pinning suspends movement without changing the Free to Wander preference; unpinning resumes the full countdown only when that preference is on. macOS Reduce Motion and Athena’s reduced-motion/DND preferences still pause wandering. Battery saving reduces rendering and particles but no longer silently disables Free to Wander. The existing `randomMovement` setting remains the single source for the toggle; `wanderIntervalSeconds` is the only wait-duration setting. Legacy `movementFrequency` and `resumeDelay` values remain readable for profile compatibility but no longer control scheduling.

## Architecture

```text
electron/main/       Windows, native movement, tray, shortcuts, persistence, IPC validation
electron/preload/    Small context-isolated API; no raw IPC or Node access
shared/             Zod schemas, typed contracts, geometry, state transitions, local intents
src/app/            Control center and surface routing
src/features/       Companion, settings, floating interactions, local command panel
src/three/          Procedural model, independent animation controller, effects, render clock
src/store/          Zustand; synchronized main-process snapshots
src/services/       Desktop bridge and explicitly labeled browser preview
tests/              Behavior tests and native Electron integration test
scripts/            Application icon generation from the source SVG
```

Three separate native windows serve the control center, transparent companion, and adjacent mini panel. The companion window is only as large as the selected character size. Native cursor hit testing lets transparent corners pass clicks through. The mini panel is a separate window so it remains usable at the minimum character size.

Settings are main-process owned, written atomically with user-only file permissions, and validated on load. Corrupt fields fall back independently; an unsupported schema version falls back to defaults. The location is clamped on startup and display changes. On macOS, preferences live in `~/Library/Application Support/Athena/settings.json`. Mini-panel messages remain in memory only.

The renderer uses a capped demand-driven render loop (20/30/45 fps by quality; 15 on battery; 8 in reduced-motion mode). Hidden windows stop the render clock. Models and geometry are managed/disposed by React Three Fiber. Appearance changes preserve the existing scene. Screen detection uses Electron display events, not repeated monitor enumeration from React.

## Security

Every renderer has `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`. IPC accepts only owned top-level frames from the application, explicit command names, and validated settings patches. Navigation, popups, webviews, and permission requests are denied. Production scripts are restricted to local files; the development server adds a per-run CSP nonce for React’s refresh preamble. There is no shell executor, AI tool execution, microphone, screen capture, arbitrary file opener, telemetry, or external renderer content. Optional OpenAI credentials are handled only in the main process and stored directly in macOS Keychain through `@napi-rs/keyring`; there is no plaintext file or browser-storage fallback. Only the trusted control-center frame can invoke the five named AI configuration operations.

Open **Settings → AI**, enter an OpenAI API key, and use **Test Connection** or **Save & Activate**. Saving always verifies that exact key first. The test calls only `GET https://api.openai.com/v1/models`; it does not send chat content or verify generation quota/billing. Choose an available Responses-compatible text model, then open **Conversation**. The saved mask is constant and reveals no portion of the key. Replacement preserves the previous credential on failure; removal deletes the Keychain entry and disables activation. Status means previously verified configuration, not continuous network availability. The production Keychain service is `com.athena.companion.openai`, account `openai-configuration`; development/test profiles use isolated hashed service names. macOS may ask you to unlock or authorize Keychain access. Unsigned local builds may prompt again after an update; signed distribution remains a release task.

Chat uses the official OpenAI SDK and streaming Responses API from the main process, with `store:false`, no automatic retries, and a 120-second overall deadline. Authorized projects expose six bounded [read-only exploration tools](docs/PROJECT_TOOLS.md) to compatible models, including directory listing, file reads and code search; other models use retrieval context. Sessions, drafts and attachments persist privately on this Mac. Send/retry transmits bounded completed history, attached content and relevant authorized source contents to OpenAI. Requests permit 12,000-character messages and 48,000-character responses. Stop aborts transport and preserves labeled partial text; retry replaces the latest assistant response. Markdown is rendered without raw HTML, navigable links or remote images. No repository code is executed. Existing mini-panel local controls are retained; AI conversation lives in the full control center. Athena pauses automated movement/actions while thinking/responding and resumes the configured countdown afterward; manual dragging still wins. “Speaking” here is an animation state only—audio is not implemented. See [storage, context budgets and file limits](docs/CONVERSATION_SYSTEM.md).

Privacy offers five default-off persisted opt-ins, separately displaying OS consent. Main-owned permission APIs validate input and accept only the control-center frame. Microphone and Accessibility prompts require explicit UI actions; Screen Recording opens a fixed settings page without capture. File opt-in alone authorizes no paths: Conversation file/folder selection is also required. Project grants expire on restart and are rechecked before every read. Renderer media access remains denied. No detection, recording, screenshots or automation is implemented. See [permission boundaries](docs/AI_PHASE_3.md) and [conversation security](docs/CONVERSATION_SYSTEM.md).

Logs contain lifecycle events, named desktop commands and permission identifiers/statuses, not conversations or credentials. A scoped `global-agent` override updates the packaging tool’s legacy proxy dependency; dependency audit reports no known vulnerabilities at implementation time.

## Verification

```sh
npm run typecheck
npm test
npm run test:desktop
```

The native test opens real Electron windows using a temporary profile, tests actual IPC and native bounds, checks transparent pixel alpha and sandboxed renderer processes, verifies size/pin/show/hide/local panel controls, observes random movement, tests screen clamping with deterministic cursor coordinates, closes the control center without quitting, then restarts to check persistence. It produces screenshots under `test-results/`. It never changes your normal Athena settings. It requires a macOS graphical session.

The test suite covers settings, geometry, command routing, accessible controls, fake-timer movement lifecycle, six fixed destinations, no immediate backtracking, speed scaling, exact arrival and synchronized flight/turn/settle poses. Native integration additionally checks restart persistence, development-renderer startup/CSP, and visible window movement after the default 30 seconds with simulated battery power and battery saving enabled. It captures flight frames and checks arrival and typed renderer flight phases at 1× and 10×.

| Acceptance | Coverage |
| --- | --- |
| AC1–AC4: startup, real transparent window, no opaque rectangle, always on top | Native launch, zero-alpha capture, window property checks, visual inspection |
| AC5: idle animation | Procedural animation + visual inspection; reduced-motion-aware |
| AC6–AC7: random motion and work-area boundaries | Native movement observation + geometry tests + drag clamp integration |
| AC8: dragging | Pointer capture and main-process cursor tracking; native bounds integration |
| AC9–AC10: stop movement and pin | Settings/state tests + native UI controls |
| AC11–AC12: bounded resizing | Zod bounds tests + actual native resize |
| AC13: hide/show | Native visibility assertions |
| AC14: tray access | Native tray and application menu created in the packaged launch; menu interaction remains a manual check |
| AC15: persistence | Fresh native process restores customized size and pin settings |
| AC16: adjacent mini panel | Native panel/local-command integration + positioning tests |
| AC17: extension-ready architecture | Independent desktop, shared contracts, renderer, and Three.js modules |

## Deliberate limits

- Speech, screen capture, semantic memory, autonomous planning, and desktop automation are **not implemented**. Permission configuration is available; enabling it does not implement or run these capabilities. Personal file/project context is restricted to explicitly selected read-only inputs. The mini panel remains an explicit local-command interface.
- Wandering stays on the current/selected monitor. Manual cross-monitor dragging and explicit “move to another monitor” are supported. Automatic travel across disconnected monitor gaps is deferred.
- Monitor geometry supports negative origins and hot-plug recovery; physical multi-monitor behavior still needs verification on a multi-display setup.
- Native dragging is tested with controlled cursor coordinates; a physical pointer/tray interaction pass remains recommended. The manual UI automation tool rejected actions with a window-state guard during this run.
- Hiding in arbitrary third-party fullscreen applications, wake phrases, and percentage-based battery rules are future work. Athena does not request accessibility/screen-recording permissions to infer other applications’ state.
- Character skins/GLB loading can replace `AthenaModel` without changing desktop behavior. The current character uses procedural primitives, so startup has no asset download dependency.
- No macOS signing/notarization is configured. This is a tested foundation prototype, not a publicly signed production release.

See [the implementation plan](docs/IMPLEMENTATION_PLAN.md) for scope and sequencing. Electron security choices follow the [official security guidance](https://www.electronjs.org/docs/latest/tutorial/security).
