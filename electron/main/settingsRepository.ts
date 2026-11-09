import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultSettings, restoreSettings, type Settings } from '../../shared/settings'
import { log } from './logger'

export class SettingsRepository {
  private file: string
  constructor(private directory: string) { this.file = join(directory, 'settings.json') }
  load(): Settings {
    try { return restoreSettings(JSON.parse(readFileSync(this.file, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log('settings.load_failed')
      return { ...defaultSettings }
    }
  }
  save(settings: Settings): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 })
    renameSync(temporary, this.file)
  }
}
