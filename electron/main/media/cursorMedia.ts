import { createHash, randomUUID } from 'node:crypto'
import { CursorACPProvider, type CursorACPService } from '../ai/cursorACP'
import type { CursorGeneralWorkspace } from '../ai/cursorGeneralWorkspace'
import type { ArtifactService } from '../ai/artifactService'
import type { GeneratedArtifact } from '../../../shared/chat'
import { cursorModelAvailable } from '../../../shared/cursor'
import type { RouteContext } from './registry'
import { MediaFailure, type MediaAdapter } from './protocols'

export async function cursorMedia(
  ctx: RouteContext,
  service: CursorACPService,
  workspace: CursorGeneralWorkspace,
  artifacts: ArtifactService,
): Promise<MediaAdapter[]> {
  if (ctx.selected !== 'cursor' || ctx.offline || !ctx.model) return []
  const status = await service.status()
  if (!status.authenticated || !status.identity || !cursorModelAvailable(status, ctx.model)) return []
  const model = ctx.model,
    identity = status.identity
  return [
    {
      id: 'cursor:' + createHash('sha256').update(identity).digest('hex').slice(0, 16) + ':' + model,
      provider: 'Cursor ACP',
      model,
      connection: 'cursor',
      native: true,
      billing: 'subscription',
      included: false,
      operations: ['image'],
      controls: [],
      async submit(job, _parent, signal) {
        const managed = await workspace.authorize(),
          dir = await artifacts.prepareProviderOutput(managed.root)
        const provider = new CursorACPProvider(
          service,
          managed.root,
          true,
          identity,
          model,
          managed.assertAccess,
          undefined,
          dir,
        )
        const receipts: GeneratedArtifact[] = []
        try {
          for await (const event of provider.streamMessage(
            [
              {
                role: 'user',
                id: randomUUID(),
                createdAt: Date.now(),
                status: 'complete',
                content: job.prompt,
              },
            ],
            {
              signal,
              permissionMode: 'read-only',
              requestApproval: async () => false,
              storeArtifact: async (input) => {
                const a = await artifacts.store(input.name, input.mimeType, input.bytes, {
                  provider: 'Cursor ACP',
                })
                receipts.push(a)
                return a
              },
            },
          )) {
            signal.throwIfAborted()
            if (event.type === 'artifact' && !receipts.some((a) => a.id === event.artifact.id))
              throw new MediaFailure('Cursor returned an unrecognized artifact reference.')
          }
          if (!receipts.length)
            throw new MediaFailure(
              'The selected Cursor runtime returned no verified image. Check its model and native image-tool availability.',
            )
          return {
            files: await Promise.all(
              receipts.map(async (a) => ({ mime: a.mimeType, bytes: await artifacts.read(a) })),
            ),
          }
        } finally {
          await Promise.allSettled(receipts.map((a) => artifacts.remove(a)))
        }
      },
    },
  ]
}
