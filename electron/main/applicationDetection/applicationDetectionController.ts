import type { AppInfo, ApplicationDetectionResult, ApplicationSnapshot } from '../../../shared/applicationDetection'
import { ChatError } from '../ai/AIProvider'
import type { ApplicationDetectionService } from './macOSApplicationDetectionService'

const DENIED = 'Application Detection is off. Enable it in Settings → Privacy before asking Athena about your apps.'

export class ApplicationDetectionController {
  constructor(private service: ApplicationDetectionService, private allowed: () => boolean) {}

  isAllowed(): boolean { return this.allowed() }
  private requireAccess(signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (!this.allowed()) throw new ChatError(DENIED)
  }
  private async guarded<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.requireAccess(signal)
    try {
      const result = await operation()
      this.requireAccess(signal)
      return result
    } catch (error) {
      if (error instanceof ChatError) throw error
      if (signal?.aborted) throw new ChatError('Application detection was cancelled.')
      throw new ChatError('Could not read application names from macOS. Try again in a moment.')
    }
  }
  active(signal?: AbortSignal): Promise<AppInfo | null> { return this.guarded(() => this.service.getActiveApplication(signal), signal) }
  running(signal?: AbortSignal): Promise<AppInfo[]> { return this.guarded(() => this.service.getRunningApplications(signal), signal) }
  snapshot(signal?: AbortSignal): Promise<ApplicationSnapshot> { return this.guarded(() => this.service.snapshot(signal), signal) }
  async preview(): Promise<ApplicationDetectionResult> {
    try { return { ok: true, ...await this.snapshot() } }
    catch (error) { return { ok: false, message: error instanceof ChatError ? error.userMessage : 'Application detection is unavailable.' } }
  }
}
