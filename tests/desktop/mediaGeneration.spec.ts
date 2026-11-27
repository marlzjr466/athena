import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mediaDefaults } from '../../shared/mediaGeneration'

test('real Electron chat routes to an isolated media protocol fixture, edits, and resumes a video after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'athena-media-e2e-')),
    requests: string[] = [],
    jobs = new Map<string, string>()
  let releaseVideo = false
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i5K0AAAAASUVORK5CYII=',
    'base64',
  )
  let video: Buffer = Buffer.alloc(0)
  const server = createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://localhost'),
      p = u.pathname
    res.setHeader('Content-Type', 'application/json')
    const reply = (body: unknown) => res.end(JSON.stringify(body))
    if (p === '/system_stats')
      return void reply({
        devices: [{ type: 'cpu', vram_total: 8 * 1024 ** 3 }],
      })
    if (p === '/object_info')
      return void reply({
        CLIPTextEncode: {},
        SaveImage: {},
        LoadImage: {},
        SaveVideo: {},
      })
    if (p === '/upload/image') {
      const data = []
      for await (const chunk of req) data.push(chunk)
      const filename = /filename="([^"]+)"/.exec(Buffer.concat(data).toString('latin1'))?.[1]
      return void reply({ name: filename, subfolder: '', type: 'input' })
    }
    if (p === '/prompt') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const graph = JSON.parse(Buffer.concat(chunks).toString()).prompt
      requests.push(graph['1'].inputs.text)
      const id = randomUUID()
      jobs.set(id, graph['2'].class_type === 'SaveVideo' ? 'webm' : 'png')
      return void reply({ prompt_id: id })
    }
    if (p.startsWith('/history/')) {
      const id = p.split('/').at(-1)!,
        ext = jobs.get(id)
      return void reply(
        !ext || (ext === 'webm' && !releaseVideo)
          ? {}
          : {
              [id]: {
                status: { completed: true, status_str: 'success' },
                outputs: {
                  '2': {
                    images: [
                      {
                        filename: 'fixture.' + ext,
                        type: 'output',
                        subfolder: '',
                      },
                    ],
                  },
                },
              },
            },
      )
    }
    if (p === '/view') {
      const image = u.searchParams.get('filename') === 'fixture.png'
      res.setHeader('Content-Type', image ? 'image/png' : 'video/webm')
      res.end(image ? png : video)
      return
    }
    res.statusCode = 404
    reply({})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('Fixture listener failed')
  const settings = mediaDefaults()
  settings.comfyPort = addr.port
  settings.image.mode = 'local'
  settings.video.mode = 'local'
  settings.workflows = (['image', 'edit-image', 'animate'] as const).map((operation) => ({
    operation,
    name: operation + ' fixture',
    minimumMemoryGB: 1,
    graph: JSON.stringify({
      1: { class_type: 'CLIPTextEncode', inputs: { text: '$prompt' } },
      2: {
        class_type: operation === 'animate' ? 'SaveVideo' : 'SaveImage',
        inputs: {},
      },
      ...(operation === 'image' ? {} : { 3: { class_type: 'LoadImage', inputs: { image: '$image' } } }),
    }),
  }))
  await writeFile(
    join(root, 'settings.json'),
    JSON.stringify({
      strictOffline: true,
      floatingEnabled: false,
      randomActions: false,
      webAccess: { automaticStartup: false, webSearchEnabled: false },
      mediaGeneration: settings,
    }),
  )
  const launch = () =>
    electron.launch({
      args: ['.'],
      env: { ...process.env, ATHENA_TEST_DATA: root },
    })
  let app = await launch()
  async function page() {
    await expect.poll(() => app.windows().some((p) => p.url().includes('surface=control'))).toBe(true)
    const c = app.windows().find((p) => p.url().includes('surface=control'))!
    await c.getByRole('button', { name: 'Conversation', exact: true }).click()
    return c
  }
  try {
    let c = await page()
    const sid = await c.evaluate(async () => (await window.athena!.getChat()).sessionId!)
    // Make a playable, synthetic protocol fixture entirely in the test window.
    video = Buffer.from(
      await c.evaluate(async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 64
        canvas.height = 64
        const draw = canvas.getContext('2d')!,
          stream = canvas.captureStream(10),
          recorder = new MediaRecorder(stream, {
            mimeType: 'video/webm;codecs=vp8',
          })
        const chunks: Blob[] = []
        recorder.ondataavailable = (e) => chunks.push(e.data)
        const stopped = new Promise<void>((r) => {
          recorder.onstop = () => r()
        })
        recorder.start()
        for (let n = 0; n < 8; n++) {
          draw.fillStyle = n % 2 ? 'green' : 'white'
          draw.fillRect(0, 0, 64, 64)
          await new Promise((r) => setTimeout(r, 100))
        }
        recorder.stop()
        await stopped
        stream.getTracks().forEach((t) => t.stop())
        return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))
      }),
    )
    const composer = c.getByRole('textbox', { name: 'Message Athena' })
    const actions = c.getByRole('button', { name: 'Composer actions' })
    await actions.click()
    await expect(c.getByRole('menuitem', { name: 'Add photos and files' })).toBeVisible()
    await expect(c.getByRole('menuitem', { name: 'Attach project folder' })).toBeVisible()
    await expect(c.getByRole('menuitem', { name: 'Voice input' })).toBeVisible()
    await expect(c.getByRole('menu', { name: 'Composer actions' })).toBeInViewport()
    const popup = await c.getByRole('menu', { name: 'Composer actions' }).boundingBox(),
      anchor = await actions.boundingBox()
    expect(popup!.y + popup!.height).toBeLessThan(anchor!.y)
    await c.screenshot({ path: '/tmp/athena-media-actions.png' })
    await c.getByRole('menuitem', { name: 'Create image' }).click()
    await expect(composer).toHaveAttribute('placeholder', 'Describe the image you want to create...')
    await composer.fill('A photorealistic emerald-green forest covered with snow')
    await c.evaluate(async () => {
      await window.athena!.chatSession({ action: 'create' })
    })
    await expect(composer).toHaveValue('')
    await expect(c.getByRole('button', { name: 'Remove generation mode' })).toHaveCount(0)
    await c.evaluate(async (id) => window.athena!.chatSession({ action: 'switch', id }), sid)
    await expect(composer).toHaveValue('A photorealistic emerald-green forest covered with snow')
    await expect(composer).toHaveAttribute('placeholder', 'Describe the image you want to create...')
    await c.screenshot({ path: '/tmp/athena-media-image-mode.png' })
    await c.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect
      .poll(
        async () =>
          c.evaluate(async () => {
            const m = (await window.athena!.getChat()).messages.at(-1)
            return m?.mediaJob?.status === 'ready' ? 'ready' : m?.content
          }),
        { timeout: 18000 },
      )
      .toBe('ready')
    await expect(c.locator('.chat-generated-image-preview')).toHaveCount(1, {
      timeout: 20000,
    })
    await expect
      .poll(() =>
        c
          .locator('.chat-generated-image-preview')
          .first()
          .evaluate((e) => (e as HTMLImageElement).naturalWidth),
      )
      .toBe(1)
    await c.getByRole('button', { name: 'Remove generation mode' }).click()
    await composer.fill('Add a waterfall')
    await c.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(c.locator('.chat-generated-image-preview')).toHaveCount(2, {
      timeout: 20000,
    })
    await c.getByRole('button', { name: 'Animate image' }).last().click()
    await expect(composer).toHaveAttribute('placeholder', 'Describe the video you want to create...')
    await composer.fill('Turn this into a cinematic video with falling snow')
    await c.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(root, 'conversations.json'), 'utf8')).sessions[0].messages.at(-1)
            .mediaJob?.remoteId,
      )
      .toBeTruthy()
    await app.close()
    releaseVideo = true
    app = await launch()
    c = await page()
    await expect(c.locator('video.media-video[controls]')).toBeVisible({
      timeout: 20000,
    })
    await expect
      .poll(() => c.locator('video.media-video').evaluate((e) => (e as HTMLVideoElement).videoWidth))
      .toBe(64)
    expect(requests).toHaveLength(3)
    expect(requests[1]).toBe('Add a waterfall')
    const result = await c.evaluate(async () => await window.athena!.getChat())
    const images = result.messages.flatMap((m) => m.artifacts ?? [])
    expect(images).toHaveLength(3)
    expect(result.messages.at(-1)?.mediaJob?.parentId).toBe(images[1].id)
    await c.getByRole('button', { name: 'AI', exact: true }).click()
    await expect(c.getByRole('heading', { name: 'Media generation', exact: true })).toBeVisible()
    const media = c.locator('.media-settings')
    await media.scrollIntoViewIfNeeded()
    await c.getByRole('button', { name: 'Check generation providers', exact: true }).click()
    await expect(c.getByRole('combobox', { name: 'Image routing mode' })).toHaveText('Local Only')
    expect(await media.locator('select').count()).toBe(0)
    await c.getByRole('heading', { name: 'Media generation', exact: true }).scrollIntoViewIfNeeded()
    await c.screenshot({ path: '/tmp/athena-media-settings.png' })
    await c.getByRole('heading', { name: 'Image generation', exact: true }).scrollIntoViewIfNeeded()
    await c.screenshot({ path: '/tmp/athena-media-settings-image.png' })
    // Exercise the shared design tokens under a light palette without changing user settings.
    await c.evaluate(() => {
      for (const [key, value] of Object.entries({
        '--surface': '#ffffff',
        '--raised': '#e8eef2',
        '--text': '#182431',
        '--muted': '#42596a',
        '--border': '#c6d2dc',
      }))
        document.documentElement.style.setProperty(key, value)
    })
    await expect(c.getByRole('combobox',{name:'Image preferred provider'})).toHaveCSS('background-color','rgb(255, 255, 255)')
    await expect(c.locator('.media-settings .setting-copy > span').first()).toHaveCSS('color','rgb(24, 36, 49)')
    await c.screenshot({ path: '/tmp/athena-media-settings-light-tokens.png' })
    expect(
      await c
        .locator('.media-settings .settings-card')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe('rgb(255, 255, 255)')
    await c.evaluate(() => document.documentElement.removeAttribute('style'))
    await c.getByRole('switch', { name: 'Enable video generation', exact: true }).click()
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).mediaGeneration.video.enabled,
      )
      .toBe(false)
    await app.close()
    app = await launch()
    c = await page()
    await expect(c.getByRole('textbox', { name: 'Message Athena' })).toHaveAttribute(
      'placeholder',
      'Describe the video you want to create...',
    )
    await c.getByRole('button', { name: 'AI', exact: true }).click()
    await expect(c.getByRole('switch', { name: 'Enable video generation', exact: true })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  } finally {
    await app.close()
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    await rm(root, { recursive: true, force: true })
  }
})
