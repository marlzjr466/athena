# AI Phase 3 — Permission system foundation

Scope: central permission policy, persisted Athena opt-ins, real OS status, explicit consent requests and a functional Privacy page. Also removes the chat textarea focus outline and typing border highlight. No Phase 4 voice recording/STT or later capture, detection, automation or file-access features are implemented.

## Architecture and boundaries

`Privacy UI → named typed IPC → PermissionService → PermissionRepository + MacOSPermissionAdapter`

- Five capabilities: `microphone`, `screenCapture`, `applicationDetection`, `desktopAutomation`, `personalFiles`.
- All opt-ins default off. Preferences live in versioned, validated, atomically replaced `permissions.json` in Athena's user-data directory. Invalid data defaults off. OS grants are never persisted or invented.
- Main-only `getPermissionStatus`, `requestPermission`, `openPermissionSettings` and `isCapabilityAllowed` centralize checks. The capability gate re-reads OS status at execution time. Future executors must also validate specific actions and approved file paths: this gate is necessary, not sufficient, authorization.
- Disabling blocks Athena immediately without revoking OS consent. A failed save keeps disabling effective in memory and reports that persistence must be retried. Enabling requires an accessible confirmation dialog; requesting OS consent is a separate user action.
- Microphone reads Electron `getMediaAccessStatus('microphone')` and requests consent through `askForMediaAccess('microphone')`. Packaged Info.plist contains `NSMicrophoneUsageDescription`. No recording starts.
- Screen reads `getMediaAccessStatus('screen')`; a fixed System Settings link lets the user manage consent. This phase never invokes capture to trigger a prompt. Athena may not appear until a future capture request; macOS can require restarting after consent changes.
- Automation reads macOS Accessibility trust without prompting. Explicit Request asks the OS for consent guidance. False trust cannot distinguish denied from never-requested, so UI says “Not granted.” Apple Events consent is separate and target-specific for future integrations.
- Basic application-name detection has no dedicated OS consent switch. Only Athena opt-in is represented; no detection runs now.
- Personal Files has no blanket OS grant. Opt-in authorizes no paths and never requests Full Disk Access. Future user-approved file/folder selection remains mandatory.
- Unsupported OS/browser environments and OS query failures display Unavailable and fail closed.
- Renderer media permission handlers remain deny-all until future scoped integrations. Credentials, chat provider, floating windows, animations, actions and movement settings are unchanged.
- Six named permission IPC operations accept only the trusted control-center top-level frame. Names and booleans are validated; arbitrary OS URLs and unknown capability names are rejected.
- OS requests coalesce per capability. Disabling while a prompt is pending is never undone by its result. UI refreshes on focus and explicit Refresh, without polling.

API behavior follows [Electron systemPreferences documentation](https://www.electronjs.org/docs/latest/api/system-preferences) and installed Electron declarations.

## Created files

- `shared/permissions.ts`
- `electron/main/permissions/permissionRepository.ts`
- `electron/main/permissions/macOSPermissionAdapter.ts`
- `electron/main/permissions/permissionService.ts`
- `src/store/permissionStore.ts`
- `src/features/settings/PermissionSettings.tsx`
- `src/styles/permissions.css`
- `tests/permissionService.test.ts`
- `tests/permissionRepository.test.ts`
- `tests/macOSPermissionAdapter.test.ts`
- `tests/desktop/permissions.spec.ts`
- `docs/AI_PHASE_3.md`

## Modified files

- `shared/contracts.ts`, `shared/ipcChannels.ts`
- `electron/main/main.ts`, `electron/main/ipcHandlers.ts`, `electron/preload/preload.ts`
- `src/services/desktop.ts`, `src/features/settings/SettingsPage.tsx`, `src/styles/chat.css`
- `package.json` (macOS microphone usage description)
- `tests/aiIPC.test.ts`, `tests/desktop/companion.spec.ts`, `tests/desktop/chat.spec.ts`
- `README.md`, `docs/IMPLEMENTATION_PLAN.md`

## Verification

- 224 unit/component tests passed, plus TypeScript. Permission coverage includes default-off, fresh OS checks/revocation, denied/restricted/unavailable, duplicate prompts, opt-out during a prompt, request/persistence failures, validation and detached snapshots.
- Repository tests verify restart persistence and no cached OS grants. Adapter tests check status mappings, prompt restrictions and fixed settings URLs. IPC rejects floating/panel/foreign/child-frame callers.
- Native permission test first reads real OS status without prompting, then uses test-only mocks for denial/grant/settings navigation and refresh. Tests modal confirmation, off-after-grant and restart persistence in an isolated profile. No real OS grants or normal-profile preferences are modified by tests.
- Chat native tests check no textarea focus outline or typing border-color change alongside streaming/layout controls.
- All seven native regression scenarios passed, including permissions, AI credential persistence, streaming chat, development startup, companion lifecycle, idle actions and native flight/landing.
- macOS package build passed. The packaged Info.plist microphone usage description was verified. Athena was restarted and the live Privacy page visually checked: all five Athena opt-ins remain off, microphone reports Not requested, Screen Recording reports Denied, and Accessibility reports Not granted. No real OS consent was requested or granted during inspection.

Phase 2's last live generation failed with `credit_balance_exhausted`. This is separate from permissions; Phase 3 does not require paid generation. Stop here until the user authorizes Phase 4.
