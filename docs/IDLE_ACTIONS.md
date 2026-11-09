# Random idle actions and selectable stops

`shared/idleActions.ts` registers typed identifiers, labels and short durations. `AthenaIdleActions.ts` maps those identifiers to local model poses. Adding an action requires a registry entry and a matching pose; the settings switches and validated identifiers derive from that registry.

The main-process `IdleActionController` owns one timeout, used either for the wait or current action completion. It publishes a timestamped session through the existing secure snapshot IPC. It does not own or move a BrowserWindow. The renderer samples the session directly, animates an inner action group and limbs, and resets to neutral on completion or cancellation. Flips shrink within the canvas; jumps and hover bounces have bounded local lift.

Eligibility requires a visible floating window at an enabled stop, idle behavior, no flight or drag, no mini panel, and no reduced-motion/DND blocker. The existing native frame loop reconciles external changes without adding another polling loop. Lifecycle events cancel immediately; restart, hide, disposal and window destruction clean up the action timeout. Pinning and disabling wandering do not disable actions at a valid stop.

Wandering and actions keep separate timers. Actions never reset the wander countdown. If an action is already running when wandering becomes due, the same wander timeout waits only for its remaining short duration before beginning flight. A flight descriptor cancels any outstanding action session. Arrival schedules a new action wait before the next wander wait, so equal default intervals still permit a short action before departure.

`enabledPositions` is a nonempty, unique validated list, defaulting to all six. Destination selection filters this list before applying repeat avoidance. The final enabled UI switch is disabled and main rejects empty updates. Invalid persisted lists recover to all six. A sole enabled destination is reached normally, then the controller parks without a wander timeout until movement/settings change.

`randomActions`, `actionIntervalSeconds` and `enabledActions` persist through the existing settings repository. Empty action lists are valid; unknown identifiers and unsafe live intervals are rejected. Saved finite intervals clamp to 10–300 seconds; malformed values use 30 seconds. Older profiles get all actions and all positions without altering their existing preferences.

Verification: 109 unit/component behavior tests and four native Electron integration tests pass. Native coverage verifies the final enabled position cannot be switched off, Athena reaches and stays at the sole stop, wave/flip sessions leave BrowserWindow bounds unchanged, disabling an action or dragging cancels it, and restart preserves the action/position choices. Existing wide-curve flight checks still pass at 1× and 10×. Renderer captures confirm a raised-arm wave and a fully contained front flip.
