# Athena web

A standalone Next.js App Router website for Athena. It runs without Electron, desktop IPC, Ollama, a voice service, API credentials, or any files outside this directory.

## Run

Requires Node.js 20.9+ and npm. From the Athena project root:

```sh
cd web
npm install
npm run dev
```

Open http://127.0.0.1:3000. For production:

```sh
npm run typecheck
npm run build
npm run start
```

Deploy this `web/` directory as the project root on a Node/Next.js host. Its lockfile and dependencies are independent. The site prerenders its content; only the 3D canvas skips SSR. Include `public/` when deploying. No desktop build is needed.

## Experience

Twelve chapters: Awakening, Meet Athena, AI Desktop Companion, Voice and Personality, Intelligence and Local AI, AI Development Partner, Athena Academy, Meeting Intelligence, Beyond the Conversation, Personalization, Desktop Downloads, and Closing Cinematic.

One persistent VRM scene follows scroll progress. GSAP ScrollTrigger coordinates the camera, avatar orientation, scene colors and holograms, progress bar, and text reveals. React Lenis smooths wheel scrolling without touch interception or pinned sections. The scene includes a metallic platform, orbital lighting, particles, data-network geometry, and holographic panels. On mobile it becomes a compact stage above the content.

- Drag to rotate, keyboard-accessible rotate/zoom/reset controls, 21 retained original clips. Sit, flip, flight, landing, and the spinning/Turn action are removed. Manual whole-avatar rotation remains available.
- Sample chat with model/reasoning selectors, sample file/image attachments, streamed scripted replies, and browser-local history/reset.
- Simulated wake-word/conversation UI plus opt-in browser speech synthesis with voice/rate selection. No microphone code or desktop voice dependency. Browser voices can use a vendor's online service; this preview does not reproduce Athena's desktop synthesis voice.
- Local/online architecture explorer with contextual-memory flow.
- Simulated Codex/Claude Code development workflow, source tabs, patch progression, and terminal output. The displayed sample tests are scripted, not executed code.
- Athena Academy with eight verified course areas, a six-stage learning walkthrough, a seven-step fine-tuning explorer, and interview practice with a clearly labeled fixed review checklist.
- Meeting Intelligence with sample transcript playback, reviewed notes, Markdown export, scripted questions/answers, and a sample screen-context explanation. No recording or screen access occurs.
- Knowledge retrieval and verified-correction previews, a web-research workflow, and permission-controlled automation examples.
- Live avatar size, animation speed, position, hover, expression, and lighting settings. Voice and AI settings are available in their respective chapters. Changes never modify the desktop app.
- Create a companion in VRoid Studio, export `.vrm`, and give it a custom name. Personalization includes a working local VRM preview, rename, replace, cancel, and Restore Athena controls, plus the official VRoid Studio download link opening in a new tab.
- Reduced-motion detection and manual toggle, semantic content, keyboard controls, model-load and WebGL fallbacks. The site remains readable without JavaScript/3D; download links are server-rendered.

## Downloads

Copy `.env.example` to `.env.local` and configure only **verified public release artifact URLs**. `NEXT_PUBLIC_*` values are bundled at build time, so rebuild after changing them. No secrets belong in these variables.

- `NEXT_PUBLIC_ATHENA_MACOS_DOWNLOAD_URL`: direct HTTPS `.dmg` release URL, or a same-origin `/downloads/...` path.
- `NEXT_PUBLIC_ATHENA_WINDOWS_DOWNLOAD_URL`: direct HTTPS `.exe` release URL, or a same-origin path.
- Optional platform-specific `VERSION`, `FILE_SIZE`, `MINIMUM_OS`, `ARCHITECTURE` variables are displayed only when supplied.
- Optional `NEXT_PUBLIC_ATHENA_REPOSITORY_URL` enables the project link.

The typed configuration is in `src/features/downloads/config.ts`. Missing or unsafe URLs disable all matching buttons in the hero, download cards, and closing. No installable `.dmg`/`.exe` or published installer URL was present in the inspected desktop project, so both platforms intentionally say **Coming soon**. The local `.app` bundle is not a downloadable installer and its version is not used as an invented website release.

Download anchors point directly to the configured artifact and use the `download` attribute. For cross-origin downloads, configure `Content-Disposition: attachment` on the release host because browsers may ignore that attribute across origins. Verify installer compatibility and metadata before configuring them.

## Your own VRoid companion

In Personalization, open [Download VRoid Studio](https://vroid.com/en/studio), create your character, then export a `.vrm` file. A `.vroid` file is the editable project, not the exported avatar. [VRoid's export guide](https://vroid.pixiv.help/hc/en-us/articles/360014383713-How-to-create-a-VRM-file) explains the export workflow.

Enter a companion name, choose the VRM, and select **Preview my model**. The preview uses the same real-time scene, original animation library, view controls, and appearance settings. Change the name with **Save name**, replace the model by choosing another file, or select **Restore Athena**. The bundled Athena model stays cached and is not fetched again when restored. Failed imports keep the last working avatar. Pending imports can be canceled; stale loads are disposed instead of taking over the scene.

The browser accepts self-contained VRM 0.x/1.0 avatars up to 50 MB with a valid humanoid rig. Names follow the desktop app's 60-character limit, control-character restrictions, and reserved built-in names. Files are read locally with `File.arrayBuffer()` and never uploaded or persisted. Models and names last only for the current page session; import separately in the desktop app to keep them there. The desktop model repository itself is unchanged and has its own limits. Individual models may provide different expressions or proportions; unsupported clips report an idle fallback.

`importValidation.ts` adapts the desktop `shared/avatarModels.ts` naming rules and `electron/main/avatarModelRepository.ts` GLB/VRM validation without importing Electron. External texture/buffer URLs are rejected, and the local loader blocks non-embedded resources. The original avatar is retained while a replacement validates and binds idle animation; old custom mixers and GPU resources are disposed after switching. This is one optional custom preview at a time, not a persistent browser model library. On devices without a working 3D scene, the import controls are disabled while the feature guidance and VRoid download link remain accessible.

## Source organization

```text
public/models/                Original model.vrm (embedded textures/materials)
public/animations/            22 original .vrma files (one web filename adapter)
public/assets/                Original Athena SVG branding
public/textures/, audio/      Reserved; no external textures/audio required
src/app/                      App Router, metadata, global/Tailwind styling
src/components/layout/        Twelve-chapter page composition
src/components/navigation/    Responsive navigation and active state
src/components/ui/            Athena CustomSelect web adapter
src/components/three/         Persistent Canvas, camera, avatar, environment
src/features/avatar/          Web VRM adapter, lazy mixer, catalog, controls
src/features/scroll-experience/ Shared settings and GSAP/Lenis orchestration
src/features/feature-demos/    Chat, voice, intelligence, code, Academy, meetings and more
src/features/downloads/       Typed release config and reusable buttons/cards
tests/                        Browser integration and release-config checks
ASSETS.md                     Copied file inventory, provenance and hashes
```

## Reuse and compatibility

The desktop app is Electron + Vite + React with npm, Tailwind and Framer Motion. Inspection found no GSAP controller to reuse. This website pins the desktop lockfile's compatible core versions: Three.js **0.180.0**, React **19.3.0**, Fiber **9.8.1**, Drei **10.7.9**, Pixiv VRM and VRM Animation **3.5.5**, and Lucide **0.468.0**. Next.js **16.4.5**, GSAP **3.15.1**, and Lenis **1.3.27** resolved in this website's lockfile. Next's [client-component lazy loading](https://nextjs.org/docs/app/guides/lazy-loading) keeps browser-dependent 3D out of SSR.

The web loader follows `src/three/vroidAssets.ts` in the desktop project: GLTFLoader with VRMLoaderPlugin/VRMAnimationLoaderPlugin, VRM0 orientation, humanoid validation, original idle priming and posed bounds. Blending follows the existing desktop controller's mixer/cross-fade/retired-action approach. Electron-dependent imports, Vite glob loading, and the desktop session clock are replaced with a local catalog and browser controller. The model-pose clip uses the web filename `model-pose.vrma` because Next production serving normalizes its original decomposed Unicode filename; its bytes are unchanged. The VRM contains its textures and materials; the standard web loader can decode them without Athena's desktop CSP image adapter.

Clips load on demand, then cache per avatar. Rapid selections are sequenced to prevent stale loads taking over. Missing clips return to idle with a visible report. Sit, flip, flight, landing, and the spinning action are no longer exposed or choreographed. The closing plays the existing wave (`goodbye.vrma`, matching the desktop controller). Head/neck transforms are owned only by the original clips; the previous per-frame additive head rotation was removed because it accumulated on clips without a head track. Blinking and gentle breathing/hover remain. The unused copied spin asset is retained to preserve the original asset inventory, but is never loaded by the catalog.


## Desktop feature and component provenance

`src/components/ui/CustomSelect.tsx` adapts the desktop component of the same name and its `src/styles/global.css` styles. It preserves the option API, trigger, chevron, and selection checkmark. Browser additions include portal positioning above clipped panels, viewport bounds, pointer/touch selection, arrow/Home/End/typeahead navigation, `aria-activedescendant`, Escape/Tab dismissal, and focus return. Every website selector uses this component; no native `<select>` remains. The desktop source is unchanged.

The additional showcases are based on these inspected desktop sources (not imported at runtime):

- `shared/academyCourses.ts`, `src/features/athena-ai/AcademyCourseView.tsx`: eight course areas and six evidence-based stages.
- `src/features/athena-ai/AcademyFineTuningView.tsx`: compatible local-model fine-tuning, dataset preparation, checkpoint evaluation and explicit activation.
- `src/features/athena-ai/AcademyStudio.tsx`: interview/coding practice and notes.
- `src/features/meetings/MeetingView.tsx`, `MeetingSettings.tsx`: local transcripts, notes, ask/quick-answer views, meeting templates, floating panel, history, and authorized screen context.
- `src/features/athena-ai/AcademyAdvanced.tsx`: optional verified corrections per model.
- `src/features/settings/WebToolsSettings.tsx`, `AutomationPermissionsSettings.tsx`: public-web research and separately controlled action categories.

Website examples are local simulations. They do not train/evaluate models, connect accounts, execute code, or request microphone/screen access. Fine-tuning availability in the desktop app depends on compatible hardware, runtime, and model architecture.

## Validation

With the dev or production server running:

```sh
npm test
# To target a different server:
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npm test
```

Tests use locally installed Google Chrome through Playwright (`channel: 'chrome'`). They cover actual model readiness, lazy loading/persistence, animation binding and missing-clip fallback, demos, personalization, download-unavailable behavior, mobile navigation, reduced motion, WebGL failure, and model failure. Screenshots/traces are written under `test-results/`.

The expanded production suite passes 14 tests. See `VALIDATION.md` for results and limitations, and `artifacts/` for reviewed desktop, tablet, and mobile previews.

Performance measures: dynamic 3D import, lazy animation requests, one persistent avatar, DPR capped at 1.5 desktop/1 mobile, fewer particles on mobile/low-power devices, no post-processing or remote environment/font fetches, rendering suspended in hidden tabs, and explicit mixer/GPU/bitmap/ScrollTrigger/listener cleanup. The unmodified model is approximately 19 MB; first-load time depends on the connection. Actual 60 FPS across device classes is not guaranteed. Browsers without WebGL2 retain all content and download access. Headless Chrome checks are not a substitute for physical iOS/Android/Safari testing.
