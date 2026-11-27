import { mkdir, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
if (process.platform === 'darwin') {
  for (const [file, binary] of [['screenCapture/screenOCR.swift', 'athena-screen-ocr'], ['desktop/desktopAccessibility.swift', 'athena-desktop-accessibility']]) {
    const source = resolve('electron/main', file)
    const output = resolve('build/native', binary)
    const old = await stat(output).catch(() => null)
    if (!old || old.mtimeMs < Math.max((await stat(source)).mtimeMs,(await stat(fileURLToPath(import.meta.url))).mtimeMs)) {
      await mkdir(resolve('build/native'), { recursive: true })
      const target=`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos13.0`
      execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', target, source, '-o', output], { stdio: 'inherit' })
    }
  }
}
