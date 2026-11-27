import { app, shell } from 'electron'
import { basename, dirname } from 'node:path'

/** Resolve the executable actually running, including a signed development bundle.
 * Never use app.getAppPath(): in development that points at source, not the app
 * macOS needs in its permission list. No renderer-supplied path is accepted. */
export function runningApplicationPath(platform = process.platform): string {
  const executable = app.getPath('exe')
  if (platform !== 'darwin') return executable
  const macos = dirname(executable), contents = dirname(macos), bundle = dirname(contents)
  if (basename(macos) !== 'MacOS' || basename(contents) !== 'Contents' || !basename(bundle).endsWith('.app')) throw new Error('The running application bundle could not be identified.')
  return bundle
}

export function revealRunningApplication(platform = process.platform): void { shell.showItemInFolder(runningApplicationPath(platform)) }
