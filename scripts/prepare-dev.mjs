import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const directory = join(root, 'out-dev')
await mkdir(directory, { recursive: true })
// Launching a package directory (rather than a JS file) preserves Athena's
// version and app identity while the development entry stays outside `out`.
await writeFile(join(directory, 'package.json'), JSON.stringify({
  name: source.name,
  productName: source.build.productName,
  version: source.version,
  type: source.type,
  main: 'main/main.js',
}, null, 2) + '\n')
