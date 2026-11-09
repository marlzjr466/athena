import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { applicationSnapshotSchema, type AppInfo, type ApplicationSnapshot } from '../../../shared/applicationDetection'

export interface ApplicationDetectionService {
  snapshot(signal?: AbortSignal): Promise<ApplicationSnapshot>
  getActiveApplication(signal?: AbortSignal): Promise<AppInfo | null>
  getRunningApplications(signal?: AbortSignal): Promise<AppInfo[]>
}

const execFileAsync = promisify(execFile)
// Fixed, read-only AppKit query. No model/user text is interpolated or executed.
const WORKSPACE_QUERY = `ObjC.import('AppKit');
var workspace = $.NSWorkspace.sharedWorkspace;
function describe(app) {
  if (!app) return null;
  var name = ObjC.unwrap(app.localizedName);
  if (!name) return null;
  var bundle = ObjC.unwrap(app.bundleIdentifier);
  return { name: String(name), bundleId: bundle ? String(bundle) : null, pid: Number(app.processIdentifier) };
}
var active = describe(workspace.frontmostApplication);
var running = workspace.runningApplications;
var apps = [];
for (var index = 0; index < running.count; index++) {
  var candidate = running.objectAtIndex(index);
  if (Number(candidate.activationPolicy) !== 0) continue;
  var info = describe(candidate);
  if (info) apps.push(info);
}
JSON.stringify({ active: active, running: apps });`

export class MacOSApplicationDetectionService implements ApplicationDetectionService {
  constructor(private platform = process.platform,
    private run: (signal?: AbortSignal) => Promise<string> = async (signal) => {
      const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', WORKSPACE_QUERY], {
        timeout: 5_000, maxBuffer: 128 * 1024, signal, encoding: 'utf8',
      })
      return stdout
    }) {}

  async snapshot(signal?: AbortSignal): Promise<ApplicationSnapshot> {
    if (this.platform !== 'darwin') throw new Error('Application detection is available on macOS only.')
    signal?.throwIfAborted()
    const parsed = applicationSnapshotSchema.parse(JSON.parse(await this.run(signal)))
    signal?.throwIfAborted()
    return { active: parsed.active, running: parsed.running.sort((a, b) => a.name.localeCompare(b.name)) }
  }
  async getActiveApplication(signal?: AbortSignal): Promise<AppInfo | null> { return (await this.snapshot(signal)).active }
  async getRunningApplications(signal?: AbortSignal): Promise<AppInfo[]> { return (await this.snapshot(signal)).running }
}
