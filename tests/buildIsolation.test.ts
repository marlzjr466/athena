// @vitest-environment node
import { describe, expect, it } from 'vitest'
import config from '../electron.vite.config'
import { developmentUserDataPath } from '../electron/main/developmentPaths'
import packageJson from '../package.json'

type OutputConfig = { main: { build: { outDir: string; watch?: unknown } }; preload: { build: { outDir: string; watch?: unknown } }; renderer: { server: { watch: { ignored: string[] } }; build: { outDir: string } } }
const configure = config as (environment: { command: 'serve' | 'build'; mode: string }) => OutputConfig

describe('development and production process isolation', () => {
  it('keeps every development artifact outside packaged production output', () => {
    const dev = configure({ command: 'serve', mode: 'development' })
    const production = configure({ command: 'build', mode: 'production' })
    for (const scope of ['main', 'preload', 'renderer'] as const) {
      expect(dev[scope].build.outDir).toContain('/out-dev/')
      expect(production[scope].build.outDir).toContain('/out/')
      expect(dev[scope].build.outDir).not.toBe(production[scope].build.outDir)
    }
    expect(dev.main.build.watch).toBeTruthy()
    expect(dev.preload.build.watch).toBeTruthy()
    expect(production.main.build.watch).toBeUndefined()
    expect(dev.renderer.server.watch.ignored).toEqual(expect.arrayContaining(['**/out/**', '**/out-dev/**', '**/release/**']))
    expect(packageJson.main).toBe('out/main/main.js')
    expect(packageJson.scripts.dev).toContain('--entry out-dev')
    expect(packageJson.build.files).toContain('out/**/*')
  })
  it('uses a persistent development lock and profile distinct from packaged data', () => {
    const appData = '/Users/test/Library/Application Support'
    expect(developmentUserDataPath(appData)).toBe(`${appData}/Athena Development`)
    expect(developmentUserDataPath(appData)).not.toBe(`${appData}/Athena`)
    expect(developmentUserDataPath(appData, '/private/tmp/athena-test')).toBe('/private/tmp/athena-test')
  })
})
