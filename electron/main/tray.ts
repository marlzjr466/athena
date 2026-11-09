import { Menu, Tray, nativeImage } from 'electron'
import type { AthenaController } from './athenaController'

export function createTray(controller: AthenaController): Tray {
  // Native RGBA template image avoids SVG support differences in macOS menu extras.
  const side = 36
  const pixels = Buffer.alloc(side * side * 4)
  for (let y = 3; y < 32; y++) for (let x = 3; x < 33; x++) {
    const half = (y - 3) * 0.44 + 1
    const outer = Math.abs(x - 18) <= half
    const inner = Math.abs(x - 18) < half - 4 && y > 12
    if (outer && (!inner || (y >= 23 && y <= 26))) pixels[(y * side + x) * 4 + 3] = 255
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: side, height: side, scaleFactor: 2 })
  icon.setTemplateImage(true)
  const tray = new Tray(icon)
  tray.setToolTip('Athena · Your desktop companion')
  const update = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Meeting Intelligence', click: () => controller.windows.showControl('meetings') },
      { label: 'Restore Meeting Panel', click: () => { controller.windows.meeting?.show(); controller.windows.meeting?.focus() } },
      { label: 'Open Athena', click: () => controller.command('open-control') },
      { label: !controller.windows.floating.isDestroyed() && controller.windows.floating.isVisible() ? 'Hide Athena' : 'Show Athena', click: () => controller.command('toggle') },
      { type: 'separator' },
      { label: controller.settings.pinned ? 'Unpin Athena' : 'Pin Athena here', click: () => controller.command(controller.settings.pinned ? 'unpin' : 'pin') },
      { label: 'Do not disturb', type: 'checkbox', checked: controller.settings.doNotDisturb, click: () => controller.updateSettings({ doNotDisturb: !controller.settings.doNotDisturb }) },
      { label: 'Mute Athena', type: 'checkbox', checked: controller.settings.voiceMuted, click: () => controller.updateSettings({ voiceMuted: !controller.settings.voiceMuted }) },
      { type: 'separator' },
      { label: 'Settings…', click: () => controller.command('open-settings') },
      { label: 'Quit Athena', click: () => controller.command('quit') },
    ]))
  }
  controller.onChange = update
  update()
  return tray
}
