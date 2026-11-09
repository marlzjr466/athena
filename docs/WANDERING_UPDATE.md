# Timed Free to Wander

Investigation found that the original controller already called `BrowserWindow.setPosition`; the failure was not a Three.js-only animation or missing IPC. Its `blocked` callback included `reduceOnBattery && powerMonitor.isOnBatteryPower()`, with battery reduction enabled by default. That silently prevented all movement on battery despite an enabled wander switch. The previous integration test explicitly disabled battery reduction, leaving this regression untested. Runtime preferences were inspected without modification: wandering was on, pinning and DND were off, and battery reduction was on. Power source at inspection was AC; the prior user's exact power state is not known. The reproduced blocker is now covered with simulated battery power in the native test.

The old scheduler also mixed an 8-second startup deadline, a 3-second settings reset, random frequency delays, a separate drag delay, and a panel-close delay. Every settings patch restarted movement, and blocked time could expire without a fresh countdown. Those paths now use one `wanderIntervalSeconds` setting and one owned timeout within the existing `MotionController`.

Implementation:

- Default 30 seconds, numeric 10–300 slider, main-process schema and atomic persistence. Legacy profiles receive 30; finite out-of-range saved values clamp, non-finite values fall back. Invalid live IPC values are rejected.
- Wait → glide → complete → wait. The existing 33ms frame loop handles native interpolation, dragging and hit testing; it does not schedule repeated journeys. Only one wander timeout exists, and none exists during a glide.
- Battery reduction remains active for rendering. Pinning, hidden windows, dragging, mini-panel interaction, DND, reduced motion and active task states suspend movement. Recovery starts the full interval. Unrelated appearance updates do not reset the countdown.
- Bounded random retries target at least 150px displacement. A farthest-valid-position fallback handles small screens. Native work-area clamping and existing cross-monitor drag behavior remain intact.
- No new renderer privileges or IPC channels. Existing model and animation code are unchanged. Native window destruction, hide, suspend and quit clean up timers.
- Development-only structured logs report scheduling, pause reasons, destinations and completion.

Automatic detection of third-party fullscreen apps was not implemented in the original prototype and is not added here. Existing hidden/suspended lifecycle events stop wandering, and resume starts a new countdown.

Native verification on macOS: with battery saving enabled and battery power simulated, enabling Free to Wander scheduled a 30-second wait, then moved the real visible window from `(1540, 832)` to `(878, 585)` over approximately 4 seconds. Changing the slider to 10 seconds scheduled the next glide at the new interval. Disabling wandering interrupted that glide. The restart test restored the configured interval. All three native integration tests passed.
