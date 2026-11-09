/** Reveal an item without letting scrollIntoView move the workspace/composer. */
export function scrollWithinTranscript(target: Element | null, block: 'center' | 'nearest' = 'nearest'): void {
  const transcript = target?.closest<HTMLElement>('.chat-transcript')
  if (!target || !transcript) return
  const viewport = transcript.getBoundingClientRect()
  const item = target.getBoundingClientRect()
  // DOM rects include interface zoom; scrollTop/clientHeight use layout pixels.
  const scale = transcript.offsetHeight ? viewport.height / transcript.offsetHeight : 1
  if (!Number.isFinite(scale) || scale <= 0) return
  const top = (item.top - viewport.top) / scale - transcript.clientTop
  const bottom = (item.bottom - viewport.top) / scale - transcript.clientTop
  const height = transcript.clientHeight
  let delta = 0
  if (block === 'center' && bottom - top <= height) delta = (top + bottom - height) / 2
  else if (top < 0) delta = top
  else if (bottom > height) delta = bottom - top > height ? top : bottom - height
  transcript.scrollTo({
    top: transcript.scrollTop + delta,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  })
}
