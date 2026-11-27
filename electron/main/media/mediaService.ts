import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Conversation } from '../ai/conversationRepository'
import type { Attachment } from '../../../shared/conversations'
import type { ChatMessage, GeneratedArtifact } from '../../../shared/chat'
import {
  isVideoOperation,
  mediaIntent,
  mediaRoutes,
  type MediaCommand,
  type MediaCatalog,
  type MediaJob,
  type MediaSettings,
} from '../../../shared/mediaGeneration'
import type { ArtifactService } from '../ai/artifactService'
import { MediaFailure, mediaMime, type MediaFile, type MediaResult } from './protocols'
import type { MediaRegistry, RouteContext } from './registry'
import { z } from 'zod'

interface MediaHost {
  session(id: string): Conversation | undefined
  persist(session: Conversation, message: ChatMessage, notify?: boolean): void
}
export type MediaCreate = Extract<MediaCommand, { action: 'generate' }>
type Parent = { item: GeneratedArtifact | Attachment; kind: 'image' | 'video' }
function parents(session: Conversation): Parent[] {
  return session.messages.flatMap((m) => [
    ...(m.artifacts ?? [])
      .filter((a) => /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm))$/.test(a.mimeType))
      .map((item) => ({
        item,
        kind: item.mimeType.split('/')[0] as 'image' | 'video',
      })),
    ...(m.attachments ?? [])
      .filter((a) => a.kind === 'image' || a.kind === 'video')
      .map((item) => ({ item, kind: item.kind as 'image' | 'video' })),
  ])
}
export class MediaService {
  private active = new Map<string, AbortController>()
  constructor(
    private registry: Pick<MediaRegistry, 'discover'>,
    private settings: () => MediaSettings,
    private routeContext: (s: Conversation) => RouteContext,
    private artifacts: ArtifactService,
    private attachment: (s: Conversation, a: Attachment) => Promise<MediaFile>,
    private ledger: string,
    private delay = 4000,
  ) {}
  async importSource(host: MediaHost, s: Conversation, file: MediaFile, name: string, parentId?: string) {
    if (mediaMime(file.bytes) !== file.mime) throw new MediaFailure('Invalid source media.')
    if (parentId && !parents(s).some((p) => p.item.id === parentId && p.kind === 'video'))
      throw new MediaFailure('Frame source does not belong to this conversation.')
    const artifact = await this.artifacts.store(name, file.mime, file.bytes)
    if (!host.session(s.id)) {
      await this.artifacts.remove(artifact)
      throw new MediaFailure('Conversation is no longer available.')
    }
    const message: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: parentId ? 'Saved video frame.' : 'Attached media for generation.',
      createdAt: Date.now(),
      status: 'complete',
      artifacts: [{ ...artifact, parentId }],
    }
    s.messages.push(message)
    host.persist(s, message)
  }
  async videoMetadata(
    host: MediaHost,
    s: Conversation,
    cmd: Extract<MediaCommand, { action: 'video-metadata' }>,
  ) {
    const message = s.messages.find((m) => m.artifacts?.some((a) => a.id === cmd.id))
    const asset = message?.artifacts?.find((a) => a.id === cmd.id && a.mimeType.startsWith('video/'))
    if (!message || !asset) throw new MediaFailure('Select a video in this conversation.')
    if (asset.width && asset.height && asset.thumbnail && (!cmd.duration || asset.duration)) return
    const thumbnail =
      !asset.thumbnail && cmd.jpeg && mediaMime(cmd.jpeg) === 'image/jpeg'
        ? await this.artifacts.store('Video thumbnail.jpg', 'image/jpeg', cmd.jpeg)
        : undefined
    if (!host.session(s.id)?.messages.includes(message) || !message.artifacts?.includes(asset)) {
      if (thumbnail) await this.artifacts.remove(thumbnail)
      return
    }
    if (thumbnail && asset.thumbnail) await this.artifacts.remove(thumbnail)
    else if (thumbnail) asset.thumbnail = thumbnail
    asset.width = cmd.width
    asset.height = cmd.height
    if (cmd.duration) asset.duration = cmd.duration
    host.persist(s, message)
  }
  async removeAsset(host: MediaHost, s: Conversation, id: string) {
    const m = s.messages.find((m) => m.artifacts?.some((a) => a.id === id)),
      a = m?.artifacts?.find((a) => a.id === id)
    if (!m || !a) throw new MediaFailure('This asset does not belong to the conversation.')
    const original = m.artifacts
    m.artifacts = original!.filter((a) => a.id !== id)
    try {
      host.persist(s, m)
    } catch (e) {
      m.artifacts = original
      throw e
    }
    await this.artifacts.remove(a)
  }
  private reservations(): string[] {
    try {
      return z.array(z.string().max(600)).parse(JSON.parse(readFileSync(this.ledger, 'utf8')))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new MediaFailure('The spending ledger could not be read. Paid generation is paused.')
    }
  }
  private month() {
    return new Date().toISOString().slice(0, 7)
  }
  private paidCount() {
    return this.reservations().filter((s) => s.startsWith(this.month() + ' ')).length
  }
  private reserve(id: string, route: string) {
    const month = this.month(),
      current = this.reservations().filter((s) => s.startsWith(month + ' ')),
      key = [month, id, route].join(' ')
    if (current.includes(key))
      throw new MediaFailure(
        'This submission already has a spending reservation. Check the provider before trying again.',
      )
    if (current.length >= this.settings().monthlyRequests)
      throw new MediaFailure('The monthly paid media request limit has been reached.')
    mkdirSync(dirname(this.ledger), { recursive: true, mode: 0o700 })
    const tmp = this.ledger + '.' + randomUUID() + '.tmp'
    writeFileSync(tmp, JSON.stringify([...current, key]), {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(tmp, this.ledger)
  }
  async catalog(s: Conversation, includedOnly = false): Promise<MediaCatalog> {
    const context = this.routeContext(s)
    const { adapters, notices } = await this.registry.discover({
      ...context,
      includedOnly,
    })
    return {
      selected: context.selected,
      offline: context.offline,
      routes: adapters
        .filter(
          (r) =>
            !includedOnly ||
            r.billing === 'local' ||
            r.billing === 'free' ||
            (r.billing === 'subscription' && r.included === true),
        )
        .map(({ submit, poll, estimate, cancel, ...route }) => route),
      notices,
      paidRequests: this.paidCount(),
    }
  }
  intent(session: Conversation, text: string) {
    const attached = session.attachments.filter((f) => f.kind === 'image' || f.kind === 'video').at(-1)
    if (session.config.mediaMode) {
      if (session.config.mediaOperation && !attached) return session.config.mediaOperation
      const source =
        attached?.kind ?? parents(session).find((p) => p.item.id === session.config.mediaParentId)?.kind
      const inferred = mediaIntent(
        text,
        (source as 'image' | 'video' | undefined) ?? parents(session).at(-1)?.kind,
      )
      return session.config.mediaMode === 'image'
        ? source === 'image' || inferred === 'edit-image'
          ? 'edit-image'
          : 'image'
        : source === 'image'
          ? 'animate'
          : source === 'video'
            ? inferred === 'extend-video'
              ? 'extend-video'
              : 'edit-video'
            : inferred && isVideoOperation(inferred)
              ? inferred
              : 'video'
    }
    if (attached) {
      const intent = mediaIntent(text, attached.kind as 'image' | 'video')
      if (intent === 'image' && attached.kind === 'image') return 'edit-image'
      if (intent === 'video') return attached.kind === 'image' ? 'animate' : 'edit-video'
      return intent
    }
    const explicit =
      /\b(?:last|previous|earlier|generated|uploaded|attached) (?:generated )?(?:image|video|photo|clip)\b|\b(?:image|video) (?:you|we) (?:generated|created)\b/i.test(
        text,
      )
    const history = explicit ? session.messages : session.messages.slice(-1)
    return mediaIntent(text, parents({ ...session, messages: history }).at(-1)?.kind)
  }
  create(
    host: MediaHost,
    s: Conversation,
    request: Pick<MediaCreate, 'requestId' | 'operation' | 'prompt' | 'parentId' | 'options'>,
  ) {
    const prior = s.messages.find((m) => m.mediaJob?.requestId === request.requestId)
    if (prior) return prior
    const all = parents(s),
      op = request.operation
    const incoming = s.messages.at(-1)?.role === 'user' ? s.messages.at(-1)?.attachments?.filter(a => a.kind === 'image' || a.kind === 'video') ?? [] : []
    if (!isVideoOperation(op) && incoming.some(a => a.kind === 'video')) throw new MediaFailure('Use Create video with this video reference, or remove it before creating an image.')
    const expected =
      op === 'edit-video' || op === 'extend-video'
        ? 'video'
        : op === 'animate' || op === 'edit-image'
          ? 'image'
          : undefined
    const parent = request.parentId
      ? all.find((p) => p.item.id === request.parentId)
      : expected
        ? all.filter((p) => p.kind === expected).at(-1)
        : op === 'gif'
          ? all.at(-1)
          : undefined
    if (
      (request.parentId && !parent) ||
      (expected && parent?.kind !== expected) ||
      (op === 'gif' && parent?.kind === 'video')
    )
      throw new MediaFailure('Select a compatible source from this conversation first.')
    if (this.active.size >= 8)
      throw new MediaFailure('Eight media requests are already active. Wait for a request to finish.')
    const now = Date.now(),
      m: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        createdAt: now,
        status: 'complete',
        content: 'Finding a generation provider…',
        mediaJob: {
          operation: op,
          prompt: request.prompt,
          parentId: parent?.item.id,
          options: Object.fromEntries(
            Object.entries({
              ...(isVideoOperation(op) ? this.settings().video : this.settings().image).defaults,
              ...request.options,
            }).filter(([, value]) => value !== undefined),
          ),
          requestId: request.requestId,
          status: 'routing',
          selected: this.routeContext(s).selected,
          attempted: [],
          started: now,
          updated: now,
        },
      }
    s.messages.push(m)
    host.persist(s, m)
    this.launch(host, s, m)
    return m
  }
  private clearPreview(m: ChatMessage) {
    const old = m.mediaPreview
    m.mediaPreview = undefined
    if (old) void this.artifacts.remove(old).catch(() => {})
  }
  private update(host: MediaHost, s: Conversation, m: ChatMessage, status: MediaJob['status'], text: string) {
    if (!host.session(s.id)?.messages.includes(m))
      throw new MediaFailure('The media request no longer belongs to an active conversation.')
    if (['ready', 'stopped', 'failed'].includes(status)) this.clearPreview(m)
    m.mediaJob!.status = status
    m.mediaJob!.updated = Date.now()
    m.content = text
    host.persist(s, m, status === 'ready' || status === 'failed')
  }
  recover(host: MediaHost, s: Conversation) {
    for (const m of s.messages) {
      const j = m.mediaJob
      if (!j) continue
      if (j.status === 'processing' && j.remoteId) this.launch(host, s, m, undefined, true)
      if (j.status === 'submitting' || j.status === 'routing')
        this.update(
          host,
          s,
          m,
          'stopped',
          j.status === 'submitting'
            ? 'Athena closed during submission. The provider may already have accepted this request. Check its history before generating again.'
            : 'Athena closed before submission. You can start a new generation.',
        )
    }
  }
  private cancelling = new Set<string>()
  async cancelProvider(host: MediaHost, s: Conversation, m: ChatMessage) {
    const job = m.mediaJob
    if (!job?.remoteId || !job.canCancel || job.status !== 'processing' || this.cancelling.has(m.id))
      throw new MediaFailure('This provider job cannot currently be cancelled.')
    const remoteId = job.remoteId
    this.cancelling.add(m.id)
    try {
      const { adapters } = await this.registry.discover(this.routeContext(s))
      const adapter = adapters.find((a) => a.id === job.route)
      if (!adapter?.cancel || job.remoteId !== remoteId || job.status !== 'processing')
        throw new MediaFailure('Refresh the job status before cancelling.')
      if (!(await adapter.cancel(remoteId, AbortSignal.timeout(15000))))
        throw new MediaFailure(
          'The provider has not confirmed cancellation. Athena will keep checking the existing job.',
        )
      if ((job.status as string) === 'ready') return
      this.active.get(m.id)?.abort()
      job.canCancel = false
      this.update(host, s, m, 'stopped', 'The provider confirmed cancellation.')
    } finally {
      this.cancelling.delete(m.id)
    }
  }
  control(
    host: MediaHost,
    s: Conversation,
    m: ChatMessage,
    action: 'approve' | 'stop' | 'track',
    route?: string,
  ) {
    const j = m.mediaJob
    if (!j) throw new MediaFailure('Media request not found.')
    if (action === 'stop') {
      this.active.get(m.id)?.abort()
      if (['approval', 'routing', 'submitting', 'processing'].includes(j.status))
        this.update(
          host,
          s,
          m,
          'stopped',
          j.status === 'approval'
            ? 'Generation declined before submission.'
            : 'Athena stopped monitoring. The provider may still complete or charge for the request.',
        )
    } else if (action === 'approve' && j.status === 'approval' && route === j.route && route) {
      this.launch(host, s, m, route)
    } else if (action === 'track' && j.remoteId && ['failed', 'stopped'].includes(j.status))
      this.launch(host, s, m, undefined, true)
    else throw new MediaFailure('This action is no longer available. Refresh the conversation.')
  }
  private launch(host: MediaHost, s: Conversation, m: ChatMessage, approved?: string, recover = false) {
    if (this.active.has(m.id)) return
    const controller = new AbortController()
    this.active.set(m.id, controller)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)])
    void this.run(host, s, m, signal, approved, recover)
      .catch((error) => {
        if (controller.signal.aborted || !host.session(s.id)?.messages.includes(m)) return
        const known = error instanceof MediaFailure
        const message = known
          ? error.message
          : signal.aborted
            ? 'Monitoring timed out. Check the provider or track the saved job again.'
            : 'Athena could not verify the provider result. Check the provider history before submitting again.'
        try {
          this.update(host, s, m, 'failed', message)
        } catch {
          /* storage or conversation unavailable */
        }
      })
      .finally(() => this.active.delete(m.id))
  }
  private async run(
    host: MediaHost,
    s: Conversation,
    m: ChatMessage,
    signal: AbortSignal,
    approved?: string,
    recover = false,
  ) {
    const j = m.mediaJob!,
      context = this.routeContext(s),
      settings = this.settings(),
      preference = isVideoOperation(j.operation) ? settings.video : settings.image
    if (!preference.enabled)
      throw new MediaFailure('This generation category is turned off in Media Generation settings.')
    if (preference.mode === 'local') context.offline = true
    if (preference.mode === 'no-charges' && !recover) context.includedOnly = true
    const { adapters } = await this.registry.discover(context)
    signal.throwIfAborted()
    const ordered = mediaRoutes(adapters, j, this.settings(), context.offline)
    const routes = recover
      ? adapters.filter((a) => a.id === j.route)
      : ordered.map((r) => adapters.find((a) => a.id === r.id)!)
    if (!routes.length)
      throw new MediaFailure(
        recover
          ? 'Reconnect the original generation endpoint to track this job.'
          : `No eligible ${isVideoOperation(j.operation) ? 'video' : 'image'} generation route${preference.mode === 'no-charges' ? ' with verified no-additional-charge access' : ''}. ${context.selected === 'subscription' ? 'The connected Sign in with ChatGPT interface has no documented generation tool. ' : ''}${context.offline || preference.mode === 'local' ? 'Configure a compatible local workflow or review offline routing' : adapters.some((a) => a.operations.includes(j.operation)) ? 'Check the selected model, routing mode, and default options' : 'Connect a compatible Google, xAI, or custom generation endpoint'} in Settings → AI → Media Generation. Paid requests require authorization.`,
      )
    if (approved && routes[0].id !== approved)
      throw new MediaFailure('The approved route changed. Review the current generation settings.')
    let last: MediaFailure | undefined
    for (const adapter of routes) {
      signal.throwIfAborted()
      const cfg = this.settings(),
        prefs = isVideoOperation(j.operation) ? cfg.video : cfg.image
      if (!prefs.enabled || (this.routeContext(s).offline && adapter.billing !== 'local'))
        throw new MediaFailure('Media generation is disabled by the current settings.')
      if (!host.session(s.id)?.messages.includes(m)) return
      Object.assign(j, {
        estimatedUSD: adapter.estimate?.(j),
        route: adapter.id,
        provider: adapter.provider,
        model: adapter.model,
        billing: adapter.billing,
      })
      let result: MediaResult
      if (
        !recover &&
        (adapter.billing === 'api' || (adapter.billing === 'subscription' && !adapter.included)) &&
        (cfg.maxCostUSD !== null || cfg.monthlyCostUSD !== null)
      ) {
        last = new MediaFailure(
          'This endpoint has no binding price quote. The configured dollar cap prevents submission.',
        )
        if (cfg.fallback && !approved) continue
        throw last
      }
      if (recover) {
        if (!adapter.poll || !j.remoteId)
          throw new MediaFailure('This provider did not supply a trackable job.')
        result = { remoteId: j.remoteId }
      } else {
        if (adapter.billing === 'subscription' && !adapter.included && approved !== adapter.id) {
          this.update(
            host,
            s,
            m,
            'approval',
            `Use the native image tool in ${adapter.provider} with ${adapter.model}? This uses your connected subscription. Its remaining allowance and possible overage charges are unavailable to Athena.`,
          )
          return
        }
        if (adapter.billing === 'api') {
          if (this.paidCount() >= cfg.monthlyRequests) {
            last = new MediaFailure('The monthly paid generation request limit is exhausted.')
            if (cfg.fallback && !approved) continue
            throw last
          }
          if (approved !== adapter.id && (cfg.confirmPaid || !cfg.paidRoutes.includes(adapter.id))) {
            this.update(
              host,
              s,
              m,
              'approval',
              `Approve one paid request to ${adapter.provider} using ${adapter.model}. ${j.estimatedUSD === undefined ? 'The provider sets the final price.' : 'Estimated USD ' + j.estimatedUSD.toFixed(2) + '; final billing may differ.'} The prompt${j.parentId ? ' and source media' : ''} will be sent to this endpoint.`,
            )
            return
          }
        }
        let parent: MediaFile | undefined
        if (j.parentId) {
          const entry = parents(s).find((p) => p.item.id === j.parentId)
          if (!entry) throw new MediaFailure('The source is no longer available in this conversation.')
          parent =
            'storageKey' in entry.item
              ? {
                  mime: entry.item.mimeType,
                  bytes: await this.artifacts.read(entry.item),
                }
              : await this.attachment(s, entry.item)
        }
        signal.throwIfAborted()
        if (!mediaRoutes([adapter], j, this.settings(), this.routeContext(s).offline).length)
          throw new MediaFailure('Media routing permissions changed before submission.')
        this.update(host, s, m, 'submitting', `Generating with ${adapter.provider} · ${adapter.model}…`)
        if (adapter.billing === 'api') this.reserve(m.id, adapter.id)
        try {
          result = await adapter.submit(j, parent, signal, async (file) => {
            signal.throwIfAborted()
            if (!cfg.image.previews) return
            if (!file.mime.startsWith('image/') || file.mime !== mediaMime(file.bytes)) return
            const preview = await this.artifacts.store(
              'Generation preview.' + file.mime.split('/')[1],
              file.mime,
              file.bytes,
            )
            if (signal.aborted || !host.session(s.id)?.messages.includes(m)) {
              await this.artifacts.remove(preview)
              return
            }
            this.clearPreview(m)
            m.mediaPreview = preview
            host.persist(s, m)
          })
        } catch (e) {
          if (!(e instanceof MediaFailure) || !e.rejected || !cfg.fallback) throw e
          j.attempted.push(adapter.id)
          last = e
          approved = undefined
          continue
        }
      }
      signal.throwIfAborted()
      if (result.remoteId) {
        j.remoteId = result.remoteId
        j.canCancel = !!adapter.cancel && !j.remoteId.startsWith('file:')
        this.update(host, s, m, 'processing', `Waiting for ${adapter.provider} · ${adapter.model}…`)
        if (!adapter.poll) throw new MediaFailure('The provider returned a job without a status interface.')
        let consecutiveErrors = 0
        while (!result.files) {
          await sleep(this.delay, undefined, { signal })
          if (!host.session(s.id)?.messages.includes(m)) return
          if (this.routeContext(s).offline && adapter.billing !== 'local')
            throw new MediaFailure('Offline mode paused remote monitoring.')
          try {
            result = await adapter.poll(j.remoteId, signal)
            consecutiveErrors = 0
            if (result.remoteId && result.remoteId !== j.remoteId) {
              j.remoteId = result.remoteId
              j.canCancel = !!adapter.cancel && !j.remoteId.startsWith('file:')
              this.update(host, s, m, 'processing', 'Retrieving generated media…')
            }
          } catch (e) {
            if (e instanceof MediaFailure || ++consecutiveErrors >= 3) throw e
          }
        }
      }
      signal.throwIfAborted()
      if (!result.files?.length || result.files.length > 8)
        throw new MediaFailure('The provider returned no usable media or too many outputs.')
      const files = result.files.map((f) => {
        const mime = mediaMime(f.bytes)
        if (
          mime !== f.mime ||
          !mime.startsWith(isVideoOperation(j.operation) ? 'video/' : 'image/') ||
          (j.operation === 'gif' && mime !== 'image/gif')
        )
          throw new MediaFailure('The delivered media did not match the requested format.')
        return f
      })
      const saved: GeneratedArtifact[] = []
      try {
        for (const f of files) {
          signal.throwIfAborted()
          saved.push(
            await this.artifacts.store(
              `Athena-${m.id.slice(0, 8)}-${saved.length + 1}.${f.mime.split('/')[1]}`,
              f.mime,
              f.bytes,
              { provider: adapter.provider },
            ),
          )
        }
        signal.throwIfAborted()
        j.usage = result.usage
        j.actualCostUSD = result.actualCostUSD
        j.revisedPrompt = files[0].revisedPrompt?.slice(0, 12000)
        m.artifacts = saved.map((a) => ({ ...a, parentId: j.parentId }))
        this.update(
          host,
          s,
          m,
          'ready',
          `${isVideoOperation(j.operation) ? 'Video' : j.operation === 'gif' ? 'Animated GIF' : 'Image'} ready · ${adapter.provider} · ${adapter.model}`,
        )
      } catch (e) {
        m.artifacts = undefined
        await Promise.allSettled(saved.map((f) => this.artifacts.remove(f)))
        throw e
      }
      return
    }
    throw last ?? new MediaFailure('Every eligible route declined submission.')
  }
  release(s: Conversation) {
    for (const m of s.messages) if (m.mediaJob) this.active.get(m.id)?.abort()
  }
  dispose() {
    for (const c of this.active.values()) c.abort()
  }
}
