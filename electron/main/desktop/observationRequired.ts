import { ChatError } from '../ai/AIProvider'
import type { AppIdentifier } from '../../../shared/desktopActions'

/** Only throw before input has been attempted. Never recover an uncertain action by replaying it. */
export class ObservationRequired extends ChatError {
  constructor(readonly app: AppIdentifier, message: string) { super(message) }
}
