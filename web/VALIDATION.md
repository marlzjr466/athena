# Validation — 2026-11-05

Final application checks:

- `npm run typecheck` — passed.
- `npm run build` — passed with Next.js 16.4.5; the homepage is statically prerendered.
- `npm run dev` — served the site independently on port 3000.
- `npm run start -- --port 3001` — served the production build independently.
- Production browser suite (`npm test`, or `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npm test` on port 3001) — **14 passed** in headless Google Chrome.
- All 24 copied assets match their desktop originals byte-for-byte (see `ASSETS.md`).
- The dependency lockfile contains one Three.js installation, version 0.180.0.

The browser suite checked the original VRM render/readiness; lazy loading and no model reload on chapter changes; all 21 retained original clips, plus absence of sit/flip/flight/landing/Turn; missing-animation idle fallback; twelve sections; model and effort selection; sample attachments; streamed scripted chat; voice conversation preview; local/online and memory controls; simulated development workflow; avatar size and lighting; absent-release disabled buttons; configured direct-download behavior using a test-only fixture; desktop (1440×1000), tablet (1024×900), and mobile (390×844) layout; reduced motion; WebGL unavailability; and model-load failure. The complete production interaction test recorded no page or console errors.


The expanded regression suite also checks every custom-select field, no native selects, keyboard arrows/Home/End/typeahead, Escape/Tab/outside dismissal, focus return, viewport bounds and touch selection. It checks Academy course progression and switching, the fine-tuning explorer, the practice checklist, Meeting Intelligence transcript playback, note review and Markdown export, scripted meeting questions, sample screen explanations, knowledge/corrections, web-research provider selection, and automation permission examples. The custom select follows smooth-scroll movement without disappearing or being clipped by its panel. Section-height changes refresh scroll choreography.

Removed the four procedural actions and the spinning/Turn clip from the website catalog and closing choreography. Removed the per-frame additive head rotation that accumulated on clips without a head track. Original head movement is retained through VRMA playback. The desktop source and source assets were not edited.

Visual QA images are saved in `artifacts/`. The browser-control host was unavailable; visual inspection used screenshots from the local automated Chrome test sessions. Testing caught and resolved overexposed VRM lighting, a waveform hydration mismatch, and a production-only Unicode asset-path issue. The model-pose web copy now uses an ASCII filename, with original bytes preserved.

The website is not connected to AI or desktop services. No real installer was available, so real release downloads and platform compatibility could not be verified. Browser speech synthesis is implemented behind an explicit click; audible output and each installed system voice were not verified. No microphone is requested. Physical Safari/iOS/Android performance, assistive-technology behavior, and a sustained 60 FPS target have not been independently benchmarked. The 19 MB model remains unmodified.

The Pixiv loader can emit non-fatal warnings for original VRMA files without a declared `specVersion` (it assumes 1.0) and for automatically creating its look-at quaternion proxy. These are upstream compatibility notices; retained original clips were validated without rewriting their data.

Preview servers were stopped after validation. Run `npm run dev` to reopen the site.
