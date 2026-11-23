import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
export default async function checkSearchBundle(context) {
  const arch = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'][context.arch]
  const target = `${context.electronPlatformName}-${arch}`
  const root = join(context.packager.projectDir, 'build/search-runtime', target)
  const manifest = await readFile(join(root, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null)
  if (manifest?.target !== target) throw new Error(`Missing compatible local search bundle for ${target}. Run npm run prepare:search on that native architecture before packaging.`)
  await access(join(root, 'python', context.electronPlatformName === 'win32' ? 'python.exe' : 'bin/python3'))
}
