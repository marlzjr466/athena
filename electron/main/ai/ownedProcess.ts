import { execFileSync, type ChildProcess } from 'node:child_process'

// Only processes spawned detached by this main process may enter this lifecycle.
// Recheck the OS parent and group before signalling; never target Athena's group.
export function ownsDetachedProcess(child: ChildProcess): boolean {
  if (!child.pid || child.pid <= 1 || child.pid === process.pid || child.pid === process.ppid || child.exitCode !== null || child.signalCode !== null) return false
  try {
    const [parent, group] = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'ppid=,pgid='], { encoding: 'utf8', timeout: 1000 }).trim().split(/\s+/).map(Number)
    return parent === process.pid && group === child.pid
  } catch { return false }
}

export function managedProcessLifecycle(child: ChildProcess, cleanup: () => void): { dispose(): Promise<void> } {
  let stopping: Promise<void> | undefined
  let closed = false
  let resolveClosed!: () => void
  const completion = new Promise<void>((resolve) => { resolveClosed = resolve })
  const finish = () => { if (closed) return; closed = true; try { cleanup() } catch { /* Cleanup errors cannot terminate the desktop process. */ } finally { resolveClosed() } }
  child.once('close', finish)
  child.once('error', finish)
  return { dispose() {
    return stopping ??= (async () => {
      if (closed) return
      if (ownsDetachedProcess(child)) {
        try { process.kill(-child.pid!, 'SIGTERM') } catch { /* Process already exited. */ }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([completion, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000) })])
      clearTimeout(timer)
      if (!closed && ownsDetachedProcess(child)) {
        try { process.kill(-child.pid!, 'SIGKILL') } catch { /* Process already exited. */ }
      }
      await Promise.race([completion, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000) })])
      clearTimeout(timer)
      if (!closed) throw new Error('Owned child process did not exit; replacement was not started.')
    })()
  } }
}
