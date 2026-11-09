export interface CaptureDisplay { id: string; name: string; width: number; height: number }
export interface ScreenImage { display: CaptureDisplay; dataURL: string; width: number; height: number; capturedAt: number }
export interface ScreenCapturePlatform {
  displays(): CaptureDisplay[]
  capture(displays: CaptureDisplay[], signal: AbortSignal): Promise<ScreenImage[]>
  dispose(): void
}
export const MAX_CAPTURE_DISPLAYS = 4
export const MAX_SCREEN_IMAGE_BYTES = 2 * 1024 * 1024
export const SCREEN_CAPTURE_SIZE = 1600
