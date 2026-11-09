# Athena startup splash

Athena opens a dedicated, sandboxed splash window while its existing control, floating, and panel windows initialize out of sight. The control renderer reports readiness only after connecting to the desktop snapshot and receiving two paint opportunities. Native readiness and service initialization are required too. A ready workspace is placed underneath the splash during the final one-second opacity crossfade, then the splash closes and the floating companion appears.

The introduction defaults to six seconds. Set `ATHENA_SPLASH_DURATION_SECONDS` to a number from 5 through 8 before launching Athena. Out-of-range values are clamped; invalid values use 6. For example:

```sh
ATHENA_SPLASH_DURATION_SECONDS=7 npm run dev
```

On Windows PowerShell:

```powershell
$env:ATHENA_SPLASH_DURATION_SECONDS = '7'
npm run dev
```

The timer begins when the splash is displayed. If application readiness takes longer than the introduction, the identity remains visible until the workspace is ready. A 45-second startup watchdog reports a failure instead of leaving an indefinite splash. Existing `startHidden`, floating visibility, and single-instance behavior are preserved. A second launch focuses the current introduction and queues the workspace activation.

## Visuals and assets

- `splash.html` and `src/startup/splash.css`: first-paint typography, navy environment, cyan/violet light, sparse composited particles, orbital accents, and soft floor glow. No remote resources or added dependencies.
- `src/startup/splash.ts`: presentation events and cleanup, with a dynamic scene import that does not hold up the first paint.
- `src/startup/splashScene.ts`: one Three.js canvas at at most 1.5 device pixel ratio. Uses the original `src/assets/avatars/vroid-athena/model.vrm`, `idle.vrma`, and `goodbye.vrma` (Athena’s existing wave) through the existing loader and animation controller. Original textures, materials, proportions, clothing, and accessories are retained. Idle animation supplies body/head movement, plus supplemental blinking and a slight floating motion.
- `shared/startup.ts`: timing configuration and IPC contract.
- `electron/main/startupGate.ts` and `startupSplash.ts`: independent timing/readiness gate and native window lifecycle.

The splash requests only its two animation clips, skips voice animations and animation-catalog registration, and does not change application state. Each native renderer owns its required GPU scene; the bundled VRM/VRMA files are reused rather than copied into a second asset set. Failed model/animation/WebGL loading leaves the typography and CSS effects running. A splash-renderer failure bypasses the intro while still waiting for the workspace. Reduced-motion preferences suppress character gestures, drift, and animated typography.

Closing the splash normally runs renderer cleanup: abort pending asset fetches, stop/uncache the animation mixer, release geometry/materials/textures/ImageBitmaps, disconnect observers/listeners, stop rendering, dispose the WebGL renderer, and release its context. The main process removes IPC listeners and timers on completion, failure, and application exit.

## Verification

```sh
npm test -- --run tests/startupGate.test.ts tests/startupSplash.test.ts tests/startupScene.test.ts tests/vroidAssets.test.ts tests/useVroidController.test.tsx tests/useVroidInstance.test.tsx tests/vroidAnimation.test.ts tests/buildIsolation.test.ts tests/rendererSecurity.test.ts
npm run build
npx playwright test tests/desktop/startup.spec.ts
```

The native suite checks the real character, authenticated preload isolation, visibility/activation gating, crossfade overlap, missing VRM/VRMA fallback, start-hidden behavior, and quitting mid-introduction. It writes `test-results/startup-identity.png` and `test-results/startup-workspace.png` for visual review. The implementation uses Electron APIs available on macOS and Windows; native platform verification must be run on each target OS.

Verified on macOS: 44 targeted unit tests, all six native startup tests, and the TypeScript/production build. After the final wave/lighting adjustment, the scene cleanup tests and native cinematic transition test passed again. Vite retains existing large-chunk and dependency annotation warnings. Final visual captures are preserved in `artifacts/startup-splash/identity.png` and `artifacts/startup-splash/workspace.png`.

The packaged macOS app was rebuilt with `npm run package`, signed and verified using the existing persistent local certificate, and restarted at `release/mac-arm64/Athena.app`. The running workspace and its original VRM were visually verified after restart. Windows native execution was not available in this environment.

## Changed source files

- Startup lifecycle: `electron/main/main.ts`, `electron/main/athenaController.ts`, `electron/main/windowManager.ts`, `electron/main/startupGate.ts` (new), `electron/main/startupSplash.ts` (new).
- Preload and build wiring: `electron/preload/preload.ts`, `electron/preload/splash.ts` (new), `electron.vite.config.ts`, `shared/startup.ts` (new).
- Renderer: `src/app/App.tsx`, `src/three/vroidAssets.ts`, `splash.html` (new), `src/startup/splash.ts` (new), `src/startup/splash.css` (new), `src/startup/splashScene.ts` (new).
- Tests (new): `tests/startupGate.test.ts`, `tests/startupSplash.test.ts`, `tests/startupScene.test.ts`, `tests/desktop/startup.spec.ts`.
- Documentation (new): `docs/startup-splash.md`.

Existing VRM/VRMA files and dependencies were not changed. `out/` and `release/` are regenerated build artifacts.
