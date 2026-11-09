export function mainFrameMediaRequestContext(input: {
  currentUrl?: string; mainFrameUrl?: string; securityOrigin?: string
}): { isMainFrame: boolean; requestingUrl?: string } {
  const { currentUrl, mainFrameUrl, securityOrigin } = input
  if (!currentUrl || !mainFrameUrl || currentUrl !== mainFrameUrl) return { isMainFrame: false, requestingUrl: mainFrameUrl }
  try {
    const frame = new URL(mainFrameUrl)
    // Node's URL implementation treats custom schemes as opaque origins even
    // though Electron registered Athena's scheme as standard/secure.
    const serializeOrigin = (url: URL) => url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin
    const frameOrigin = serializeOrigin(frame)
    // Chromium can serialize a custom secure scheme's origin with a trailing
    // slash. Compare parsed origins, not raw strings; the trusted full document
    // URL is still checked separately by the caller.
    if (securityOrigin && serializeOrigin(new URL(securityOrigin)) !== frameOrigin) return { isMainFrame: false, requestingUrl: mainFrameUrl }
    return { isMainFrame: true, requestingUrl: mainFrameUrl }
  } catch { return { isMainFrame: false, requestingUrl: mainFrameUrl } }
}

export function allowsVoiceMedia(input: {
  senderId?: number; controlId: number; permission: string; isMainFrame: boolean
  requestingUrl?: string; controlUrl: string; mediaTypes: string[]; captureAllowed: boolean
}): boolean {
  return input.captureAllowed && input.senderId === input.controlId && input.permission === 'media'
    && input.isMainFrame && Boolean(input.controlUrl) && input.requestingUrl === input.controlUrl
    && input.mediaTypes.length === 1 && input.mediaTypes[0] === 'audio'
}
