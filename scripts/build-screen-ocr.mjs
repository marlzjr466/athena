import { mkdir, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
if (process.platform === 'darwin') {
  const source = resolve('electron/main/screenCapture/screenOCR.swift')
  const output = resolve('build/native/athena-screen-ocr')
  const old = await stat(output).catch(() => null)
  if (!old || old.mtimeMs < Math.max((await stat(source)).mtimeMs,(await stat(fileURLToPath(import.meta.url))).mtimeMs)) {
    await mkdir(resolve('build/native'), { recursive: true })
    const target=`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos13.0`
    execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', target, source, '-o', output], { stdio: 'inherit' })
  }
}
