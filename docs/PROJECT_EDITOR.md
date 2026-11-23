# Open project in Visual Studio Code

Project conversation headers expose one fixed editor action through `athena:project-editor`.
The renderer sends only a conversation/workspace reference. The main process resolves the
authorized directory, checks that it still exists and is accessible, and revalidates the
selected conversation immediately before dispatch. Arbitrary paths, executables and CLI
options are rejected. Git is not required and no Git or project terminal commands are run.

## Detection and launch

- macOS: check `/Applications` and the user's `Applications` folder, then Launch Services
  discovery through `NSWorkspace`. Validate the VS Code bundle identity and executable.
  Launch with macOS `open -a <detected application> -- <authorized folder>`, sharing Athena's
  existing shell-free desktop folder launcher. This does not require the `code` PATH shim.
- Windows: check per-user and system installation directories, then HKCU/HKLM App Paths
  and Applications registrations in both registry views. Validate `Code.exe`, the bundled CLI and VS Code product identity.
  Invoke the bundled CLI using the same executable/script arrangement as VS Code's official
  `code.cmd`, with argument arrays and `--new-window`. The launcher process exits after
  dispatch; Athena does not wait on or kill the editor's GUI process.
- Cache positive and negative detection for 60 seconds, with deduplicated checks. While a
  project header is mounted, visible-page, focus and periodic checks pick up installation
  changes. Every launch performs fresh detection and project validation.
- The main process and UI both prevent concurrent duplicate launches. Errors appear in a
  dismissible conversation notice; successful dispatch does not claim editor contents were
  inspected. Other VS Code windows and Athena's project/branch selection are preserved.

The explicit header action uses existing project access grants. It does not change Desktop
Automation permission or the permissions required by agent-initiated desktop tools.
VS Code retains its own workspace trust and extension policies.

References: [VS Code CLI](https://code.visualstudio.com/docs/configure/command-line),
[Windows installations](https://code.visualstudio.com/docs/setup/windows),
[Windows App Paths](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration),
[official Windows CLI launcher](https://github.com/microsoft/vscode/blob/main/resources/win32/bin/code.cmd).

## Verification

`tests/vscodeApplication.test.ts` mocks macOS/Windows discovery and process dispatch,
including cached installation changes, missing executables and safe CLI arguments.
Set `ATHENA_VSCODE_LIVE=1` to also test real macOS detection without `code` in PATH.
`tests/projectEditor.test.ts` uses real temporary workspace grants and folders to check
authorization, replacement symlinks, missing folders, stale conversations and deduplication.
`tests/openInVSCode.test.tsx` covers visibility, loading, error and refresh behavior.
`tests/aiIPC.test.ts` checks sender authority. `tests/desktop/projectEditor.spec.ts` exercises
the Electron UI/IPC using temporary non-Git projects without opening an external editor.

Windows dispatch is tested with mocked operating-system responses; an actual Windows
packaged launch still requires a Windows host. Live editor launch verification should use
the project button and observe VS Code, without closing unrelated editor windows.
