import { CanvasTexture, SRGBColorSpace } from 'three'
import type { TaskVisualMode } from '../../shared/contracts'

function fit(context: CanvasRenderingContext2D, text: string, width: number) {
  let result = text.replace(/\s+/g, ' ').trim()
  while (result && context.measureText(result).width > width) result = result.slice(0, -1)
  return result === text.trim() ? result : `${result.trimEnd()}…`
}

export const isCodingScreen = (title: string) => ['Terminal', 'Read', 'Edit', 'Create', 'Build'].includes(title)

/** Generated only when activity metadata changes, never per animation frame.
 * The diagrams are activity illustrations, not fabricated logs/results. */
export function taskScreenTexture(title: string, label: string, detailed: boolean, mode: TaskVisualMode) {
  const canvas = document.createElement('canvas')
  canvas.width = 768; canvas.height = 384
  const ctx = canvas.getContext('2d')!
  const accent = mode === 'completed' ? '#91ffd0' : mode === 'failed' ? '#ffb175' : mode === 'cancelled' ? '#aebdca' : '#71e8ff'
  const background = ctx.createLinearGradient(0, 0, 768, 384)
  background.addColorStop(0, 'rgba(3, 28, 46, .81)')
  background.addColorStop(.5, 'rgba(9, 60, 79, .67)')
  background.addColorStop(1, 'rgba(3, 28, 46, .81)')
  ctx.beginPath(); ctx.roundRect(8, 8, 752, 368, 24)
  ctx.fillStyle = background; ctx.fill()
  ctx.lineWidth = 2; ctx.strokeStyle = accent; ctx.shadowColor = accent; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0
  ctx.fillStyle = accent; ctx.font = '600 29px system-ui'; ctx.fillText(title.toUpperCase(), 32, 52)
  ctx.font = '19px system-ui'; ctx.fillStyle = '#c4ecf6'; ctx.fillText(fit(ctx, label, 690), 32, 85)
  ctx.strokeStyle = '#72dbff55'; ctx.beginPath(); ctx.moveTo(32, 104); ctx.lineTo(735, 104); ctx.stroke()
  // Thin telemetry band, visually subordinate to the current activity.
  for (let i = 0; i < 17; i++) { ctx.fillStyle = i % 4 ? '#43bbd45a' : accent; ctx.fillRect(558 + i * 10, 33, 6, 14) }
  const end = ['completed', 'failed', 'cancelled'].includes(mode)
  if (end) {
    ctx.strokeStyle = accent; ctx.lineWidth = 4
    ctx.beginPath(); ctx.arc(526, 231, 58, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath()
    if (mode === 'completed') { ctx.moveTo(497, 231); ctx.lineTo(519, 250); ctx.lineTo(557, 207) }
    else if (mode === 'failed') { ctx.moveTo(526, 203); ctx.lineTo(526, 239); ctx.moveTo(526, 251); ctx.lineTo(526, 255) }
    else { ctx.moveTo(504, 231); ctx.lineTo(548, 231) }
    ctx.stroke()
  } else if (isCodingScreen(title)) {
    const lines = ['// activity visualization', 'async function work() {', '  const task = await inspect();', '  for (const file of task.files) {', '    const next = transform(file);', '    await validate(next);', '  }', '}']
    ctx.font = '16px monospace'
    lines.slice(0, detailed ? 8 : 4).forEach((line, index) => {
      const y = 145 + index * 24
      ctx.fillStyle = '#6ba1b8'; ctx.fillText(String(index + 1).padStart(2, '0'), 349, y)
      ctx.fillStyle = index === 0 ? '#6babbc' : index % 3 === 1 ? '#a5b9ff' : '#76eadb'
      ctx.fillText(line, 380, y)
    })
  } else if (title === 'Working') {
    ctx.strokeStyle = accent
    for (const radius of [30, 55, 81]) { ctx.beginPath(); ctx.arc(529, 230, radius, -.6, Math.PI * 1.5); ctx.stroke() }
    for (let i = 0; i < 7; i++) { ctx.fillStyle = '#53d8f580'; ctx.fillRect(653, 170 + i * 20, 28 + (i % 3) * 12, 5) }
  } else if (title === 'Browser') {
    ctx.strokeStyle = accent; ctx.strokeRect(349, 133, 365, 198)
    ctx.fillStyle = '#4cbed84a'; ctx.fillRect(350, 134, 363, 23)
    ctx.fillRect(370, 178, 114, 131); ctx.fillRect(502, 178, 191, 45)
    for (let i = 0; i < 4; i++) ctx.fillRect(502, 239 + i * 19, 169 - i * 17, 5)
  } else {
    for (let i = 0; i < (detailed ? 8 : 4); i++) {
      const y = 145 + i * 24
      const indent = title === 'Explore' ? (i % 3) * 20 : title === 'Edit' || title === 'Create' ? (i % 3) * 10 : 0
      ctx.strokeStyle = accent; ctx.fillStyle = accent
      if (title === 'Verify') ctx.strokeRect(351, y - 5, 11, 11)
      else if (title === 'Search') { ctx.beginPath(); ctx.arc(356, y, 5, 0, Math.PI * 2); ctx.stroke() }
      else if (title === 'Terminal') { ctx.font = '16px monospace'; ctx.fillText('›', 350, y + 5) }
      else ctx.fillRect(351 + indent, y - 3, 7, 6)
      ctx.fillStyle = (title === 'Edit' || title === 'Create') && i % 3 === 0 ? '#87f1c9b0' : title === 'Delete' ? '#f4b5928c' : '#71e8ff8c'
      ctx.fillRect(376 + indent, y - 2, [262, 193, 228, 154][i % 4] - indent, 4)
    }
  }
  if (detailed) {
    // One console surface, not independent screen meshes.
    ctx.strokeStyle = '#75d9f74a'; ctx.beginPath(); ctx.arc(151, 193, 50, 0, Math.PI * 1.6); ctx.stroke()
    ctx.beginPath(); ctx.arc(151, 193, 33, 0, Math.PI * 2); ctx.stroke()
    for (let i = 0; i < 5; i++) { ctx.fillStyle = '#72dbff65'; ctx.fillRect(48, 272 + i * 13, 157 - (i % 3) * 29, 3) }
    ctx.strokeStyle = '#72dbff30'; ctx.beginPath(); ctx.moveTo(287, 131); ctx.lineTo(287, 334); ctx.stroke()
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}
