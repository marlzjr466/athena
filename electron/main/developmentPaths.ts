import { join } from 'node:path'

/** Persistent dev profile; a test override keeps desktop integration tests isolated. */
export function developmentUserDataPath(appData: string, testOverride?: string): string {
  return testOverride || join(appData, 'Athena Development')
}
