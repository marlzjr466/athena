# Local VRM imports

## Workflow

My Companion → **Add Model** → choose a `.vrm` file → enter a unique model name → **Import Model**. Selecting a file alone does not import it. Names are trimmed, limited to 60 characters, Unicode-capable, and compared case-insensitively with normalized existing/bundled names. Control characters are rejected. A pencil button on imported cards opens Rename Model; renaming does not reload or replace assets.

Each import receives an `imported-<UUID>` identity. Local files are stored under Electron's `userData/avatars/<UUID-prefixed-id>/`, independently of bundled assets. The registry stores source filename, custom name, status, progress stage, compatible clips, enabled actions, random-action configuration, normalization scale, model version, and thumbnail location. Settings store the selected ID, not its name.

The file picker returns a short-lived capability token, not an unrestricted renderer-supplied path. The main process validates GLB/VRM metadata, required humanoid data, file size (150 MB maximum), and embedded-resource requirements. Arbitrary external texture/buffer URLs are rejected. Reads resolve only registered model IDs inside their own canonical storage directory. Import/rename/registration/preferences APIs are restricted to the trusted control window; the floating window can read registered model assets. Corrupt registry files are preserved rather than silently overwritten.

## Animation and presentation

The existing VRM loader and shared VRMA registry are reused. Every clip is retargeted to the imported avatar's own humanoid and validated separately. A usable Idle clip is required for activation. Other incompatible clips are reported individually. The current project contains 20 registered VRMA files; no Fly file exists in that registered folder. This implementation does not manufacture a Fly animation or fetch external assets.

Each canvas has independent VRM scenes, skeletons, and mixers. The existing main-process scheduler remains the sole random-action authority: Idle + transition settling → 3 seconds → enabled random action once → Idle. Switching model IDs resets the old logical playback catalog; late reports for another model are ignored. Independent per-model action preferences do not change bundled avatar preferences.

The outgoing scene is retained until the incoming model is ready and the existing turning/fade wrapper commits its swap. Model cleanup happens after that handoff. The original materials, facial support, spring bones, movement controller, voice behavior, holograms, and size settings remain in use. Preview framing uses posed bounds and the existing responsive 80% framing policy; floating size stays independent.

Import preparation renders one offscreen frame of the actual model to a transparent PNG with a measured head/shoulder crop. The cached PNG avoids continuously running a second model for each card. Progress is stage-based and indeterminate: percentages are not invented for shader/geometry/retargeting work. The ready card exposes a Ready to use tooltip. Failed cards retain their name and offer Retry; a missing/invalid saved file prompts for a replacement source. Renderer interruption marks unfinished imports retryable.

## Verification performed — 2026-10-19

- `npm run typecheck`: passed.
- 124 focused tests across 12 files: passed. Coverage includes names, duplicate validation, persistence/reload, malformed files, external-resource rejection, path escapes, source retry, corrupted registry preservation, dialog confirmation/cancel/rename, model-specific settings and selection, shared scheduler, imported-to-imported transitions, instance cleanup, IPC authority, and all 20 real VRMA clips deforming the actual humanoid skeleton.
- One approved `npm run dev` session started. No production build or second dev server was started.
- Native picker selected the real bundled `model.vrm`, imported as **Luna**, generated a real portrait, and registered all 20 clips as compatible.
- Clicked the ready card, observed the imported model rendered and animating in the preview, and observed turning/fading when switching.
- Renamed the same stable model to **Luna Test**; labels, controls and action settings updated without reimporting.
- Navigated away and back; model name/selection and playback resumed. Inspected the actual floating window: it displayed the imported VRM, animated, and exposed `Luna Test floating companion` plus model-specific controls.
- Restored the original bundled **Athena** selection and floating visibility. The **Luna Test** record remains available as the real import verification sample.
- Read back the persisted registry: ready status, stable ID, custom name, generated thumbnail path, and 20 compatible clips. Automated tests restore a new repository instance and settings from disk.

### Verification limits

The live sample was a VRM 1.0 model. A separate real VRM 0.x model was not available for visual verification; version handling and front-orientation correction are implemented. An additional application restart was not performed solely to test persistence; disk reload is covered by automated tests. Arbitrary third-party models with unusual materials or malformed/unsupported humanoids may fail validation with a retryable error. No claim is made that every possible VRM is compatible.

## Files changed

- Shared: `shared/avatarModels.ts`, `shared/settings.ts`, `shared/contracts.ts`, `shared/ipcChannels.ts`.
- Desktop: `electron/main/avatarModelRepository.ts`, `electron/main/athenaController.ts`, `electron/main/vroidActionScheduler.ts`, `electron/main/ipcHandlers.ts`, `electron/preload/preload.ts`.
- Rendering: `src/three/vroidAssets.ts`, `src/three/useVroidInstance.ts`, `src/three/importAvatar.ts`, `src/three/VroidAvatar.tsx`, `src/three/CompanionShowcaseScene.tsx`, `src/three/AthenaScene.tsx`.
- UI: `src/features/athena/ModelDialog.tsx`, `src/features/athena/CompanionShowcase.tsx`, `src/features/athena/CompanionPage.tsx`, `src/features/athena/companionShowcase.css`, `src/features/settings/VroidActionSettings.tsx`, `src/features/settings/SettingsPage.tsx`, `src/features/floating/FloatingAthena.tsx`, `src/features/floating/MiniPanel.tsx`, `src/services/desktop.ts`.
- Tests: `tests/avatarModels.test.ts`, `tests/modelDialog.test.tsx`, `tests/companionShowcase.test.tsx`, `tests/taskActivityController.test.ts`, `tests/aiIPC.test.ts`, `tests/useVroidInstance.test.tsx`, `tests/floatingAvatarTransition.test.tsx`.

Classic and Enhanced remain implemented, with their previous hidden-picker presentation preserved. The application name, AI assistant identity, providers, and conversation settings are unchanged.
