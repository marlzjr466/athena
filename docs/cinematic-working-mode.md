# Cinematic hologram Working Mode

## Behavior

- Reuses the existing `taskVisual` snapshot from chat, voice and agent activity. No new task/event system or provider requests.
- A scene-local quaternion transition turns Athena approximately 137° into a rear three-quarter presentation. The camera and character's desktop anchor stay fixed. The existing transparent task canvas supplies the necessary margin.
- One curved Three.js mesh sits in Athena's forward local coordinates. Its readable side faces her; normal depth testing remains enabled, so the robot and hands occlude the console correctly.
- Terminal, Explore, Search, Read, Edit, Create, Delete, Build, Verify, Browser and processing visuals update the same mesh. These are activity illustrations, not invented terminal output or verification results.
- Two-joint procedural arm control extends the existing character rig with elbows and fingertips. Head tracking, fingertip targets and touch ripples share console coordinates. Reading/searching scan; editing/terminal work uses small taps.
- One short-range cyan light illuminates the shell and hands. The console uses a single shader for focus, scan lines and ripples, without bloom passes or overlay meshes.
- Work pauses wandering, flights and random actions. Listening takes priority; speaking/lip-sync remains connected to the original voice amplitude path.
- Success displays a green confirmation and small nod; failure uses amber; cancellation fades neutrally. Arms lower and the scene returns to its normal orientation before normal movement resumes.
- Horizontal composition mirrors inward at display edges; console height adapts vertically without relocating the character. The My companion preview remains independent of desktop task positioning.

## Follow-up: console distance, coding and fixed position

- Moved the console forward from 0.49 to 0.62 scene units. Arm articulation reaches the new surface while the idle arm length stays unchanged.
- Gaze dwells at varied left, right, upper and lower screen regions, using smooth seeded transitions. Hands alternate distinct press/hold/retract cycles with corresponding ripples.
- Coding modes display illustrative code with progressive typing and a blinking cursor on the existing shader. No per-frame texture redraw or actual command execution is involved.
- Removed macOS native animation from task-window bounds changes. Replaced the resize-dependent camera dolly and translated scene with a fixed perspective camera and cropped/expanded view offset. This preserves both the desktop anchor and depth scale at entry/exit.
- Preserved the original turning direction when returning to idle, even after an edge-mirrored task layout disappears.

## Follow-up: completion flicker and additional clearance

- Moved the console from 0.62 to 0.74 scene units and adjusted articulated arm reach; the idle arm length stays at 0.4 units.
- Completion notifications are idempotent. Duplicate callbacks cannot extend the ending timer, and late callbacks cannot reopen a completed visual. Corrected failure/cancellation outcomes update the screen without restarting its fade.
- The single console mesh and its light remain allocated after the first task. They fade to invisible/zero intensity and are reused on the next task, avoiding a change in the scene's light count and character shader recompilation at completion.
- Texture swaps happen before the previous texture is disposed. Hidden console frames skip activity animation calculations.
- Focused regression checks: **38 passed**. Production build and TypeScript checks passed. The earlier full-suite totals below belong to the previous update.
- Native Electron check: **1 passed (39.8 seconds)**. Sampled success, failure and cancellation fades for monotonic opacity; verified stable screen/light identity and shader-program count through idle and the following task. Desktop anchors stayed fixed, both hands reached the farther surface, and no WebGL/renderer errors occurred.

## Performance

Frame transforms and shader uniforms are updated through R3F, without per-frame React state. Geometry is reused through activity changes. A bounded 768×384 texture is regenerated only for changed activity metadata and disposed on replacement. Existing hidden-window, reduced-motion, battery and frame-rate controls remain in effect. No new dependencies, database or external assets were introduced.

Native tests verify a single persistent screen mesh/geometry and bounded texture counts through mode changes. This is not a long-duration CPU/GPU or thermal benchmark.

## Validation

- TypeScript checking and production build: passed. Existing dependency annotation and bundle-size warnings remain.
- Full Vitest suite: **780 passed, 9 skipped** across **94 passed, 2 skipped** files.
- Focused task/pose/controller/window tests: **35 passed**. Cover activity mapping, permissions-independent visual lifecycle, both hands' reach, reduced motion, listening priority, outcome envelopes, gaze coverage/continuity, alternating contact, native nonanimated bounds, fixed projection and edge bounds at 120/180/280px avatar sizes.
- Native Electron test: **1 passed**. Covers actual WebGL rendering, live shader opacity, single-mesh reuse, activity changes, listening interruption, edge mirroring, success/failure/cancellation, normal-pose restoration, preserved companion preview and unchanged process identity. No WebGL or renderer errors.
- Follow-up native checks also sampled desktop-anchor coordinates throughout entry/exit, observed live code uniforms and both tapping hands, and verified head rotation ranges across a full gaze cycle. Final native run: **38.2 seconds, passed**.
- Captures inspected: `test-results/task-terminal.png`, `task-create.png`, `task-edge.png`, `task-completed.png`, `task-returned-idle.png`, `task-companion-preview.png`.

The native test uses an isolated profile and deterministic activity events; it does not send paid AI requests, invoke the microphone, or modify the user's conversations/projects.

## Source files changed

- `shared/taskHologramLayout.ts`
- `src/three/TaskWorkingMode.tsx` (new)
- `src/three/taskWorkingPose.ts` (new)
- `src/three/taskScreenContent.ts` (new)
- `src/three/TaskWorkScreen.tsx`
- `src/three/AthenaModel.tsx`
- `src/three/AthenaAnimations.ts`
- `src/three/AthenaScene.tsx`
- `src/three/floatingProjection.ts` (new)
- `src/features/settings/SettingsPage.tsx`
- `electron/main/athenaController.ts`
- `electron/main/windowManager.ts` (composition comment)
- `tests/taskWorkingMode.test.ts` (new)
- `tests/taskWindowPosition.test.ts` (new)
- `tests/taskVisuals.test.tsx`
- `tests/taskActivityController.test.ts`
- `tests/desktop/taskVisuals.spec.ts`
- This report.
