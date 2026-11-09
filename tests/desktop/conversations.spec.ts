import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'

test('persistent sessions, model effort, attachments, source context and permission isolation', async () => {
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'athena-conversation-e2e-'))
  const project = await mkdtemp(join(tmpdir(), 'athena-source-e2e-'))
  await mkdir(join(project, 'src'))
  await writeFile(join(project, 'src', 'auth.ts'), 'export function authenticate(user: string) {\n  return user.length > 0\n}\n')
  await writeFile(join(project, '.env'), 'SECRET=not-for-provider')
  const docx = new JSZip()
  docx.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  docx.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  docx.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Athena document extraction works.</w:t></w:r></w:p></w:body></w:document>')
  const docxBytes = [...await docx.generateAsync({ type: 'uint8array' })]
  let app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    await expect.poll(() => app.windows().length).toBe(3)
    let control = app.windows().find((page) => page.url().includes('surface=control'))!
    await app.evaluate(() => {
      const state = globalThis as unknown as { conversationRequests: unknown[] }
      state.conversationRequests = []
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/models')) return new Response(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4.1' }, { id: 'gpt-5.2' }] }))
        state.conversationRequests.push(JSON.parse(init!.body as string))
        return new Response([{ type: 'response.output_text.delta', delta: '**Verified** reply with `source`.' }, { type: 'response.completed', response: {} }].map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
    })
    await control.evaluate(async () => { await window.athena!.activateAI({ apiKey: 'sk-conversation-test-not-a-real-key' }); await window.athena!.selectAIModel({ model: 'gpt-4.1' }) })
    await control.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(control.getByRole('combobox', { name: 'Conversation model' })).toHaveValue('gpt-4.1')
    const first = (await control.evaluate(() => window.athena!.getChat())).sessionId!
    const importText = (name: string, text: string) => control.evaluate(({ first, name, text }) => window.athena!.chatContext({ action: 'import', sessionId: first, name, bytes: new TextEncoder().encode(text) }), { first, name, text })
    expect((await importText('notes.txt', 'Remember Athena')).ok).toBe(false)
    await control.evaluate(() => window.athena!.setPermissionEnabled({ permission: 'personalFiles', enabled: true }))
    expect((await importText('notes.txt', 'Remember Athena')).ok).toBe(true)
    const document = await control.evaluate(({ first, docxBytes }) => window.athena!.chatContext({ action: 'import', sessionId: first, name: 'report.docx', bytes: new Uint8Array(docxBytes) }), { first, docxBytes })
    expect(document, JSON.stringify(document)).toMatchObject({ ok: true })
    const files = (await control.evaluate(() => window.athena!.getChat())).attachments!
    expect((await control.evaluate(({ first, id }) => window.athena!.chatContext({ action: 'preview', sessionId: first, id }), { first, id: files[1].id })).text).toContain('Athena document extraction works.')
    const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n5 0 obj<</Length 49>>stream\nBT /F1 12 Tf 20 100 Td (Athena PDF text) Tj ET\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF'
    const pdfResult = await importText('test.pdf', pdf)
    expect(pdfResult, JSON.stringify(pdfResult)).toMatchObject({ ok: true })
    const png = await app.evaluate(({ nativeImage }) => [...nativeImage.createFromBitmap(Buffer.from([0, 150, 255, 255]), { width: 1, height: 1 }).toPNG()])
    expect((await control.evaluate(({ first, png }) => window.athena!.chatContext({ action: 'import', sessionId: first, name: 'image.png', bytes: new Uint8Array(png) }), { first, png })).ok).toBe(true)
    await expect(control.locator('.attachment-card')).toHaveCount(4)
    await expect(control.locator('.attachment-card img')).toBeVisible()
    await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }) }, project)
    await control.getByRole('button', { name: 'Connect project folder' }).click()
    await expect(control.getByRole('region', { name: 'Project source browser' })).toBeVisible()
    await expect(control.getByRole('button', { name: 'Attach src/auth.ts' })).toBeVisible()
    await control.getByRole('textbox', { name: 'Search project files and code' }).fill('return user')
    await expect(control.getByText('src/auth.ts:2', { exact: true })).toBeVisible()
    await control.getByRole('button', { name: 'Close project browser' }).click()
    await control.getByRole('combobox', { name: 'Conversation model' }).selectOption('gpt-5.2')
    await control.getByRole('combobox', { name: 'Reasoning effort' }).selectOption('high')
    await control.getByRole('textbox', { name: 'Message Athena' }).fill('Explain authentication and my attached notes')
    await control.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getChat())).messages.at(-1)?.status).toBe('complete')
    const request = await app.evaluate(() => (globalThis as unknown as { conversationRequests: Array<{ reasoning?: { effort: string }; input: unknown }> }).conversationRequests[0])
    expect(request.reasoning?.effort).toBe('high'); expect(JSON.stringify(request.input)).toContain('input_image')
    expect(JSON.stringify(request.input)).toContain('1: export function authenticate'); expect(JSON.stringify(request.input)).toContain('Athena document extraction works.')
    expect(JSON.stringify(request.input)).not.toContain('not-for-provider')
    await control.getByRole('button', { name: 'Edit message', exact: true }).click()
    await control.getByRole('textbox', { name: 'Edit message' }).fill('Explain the authenticate function')
    await control.getByRole('button', { name: 'Save & resend' }).click()
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getChat())).messages.at(-1)?.status).toBe('complete')
    expect((await control.evaluate(() => window.athena!.getChat())).messages).toHaveLength(2)
    await control.getByRole('button', { name: 'New chat', exact: true }).click()
    const second = (await control.evaluate(() => window.athena!.getChat())).sessionId!
    expect(second).not.toBe(first)
    expect((await control.evaluate(() => window.athena!.getChat())).attachments).toEqual([])
    expect((await control.evaluate(({ second, id }) => window.athena!.chatContext({ action: 'preview', sessionId: second, id }), { second, id: files[0].id })).ok).toBe(false)
    // Switching away from a legacy saved model offers only the latest generation.
    await expect(control.getByRole('combobox', { name: 'Conversation model' }).locator('option:not(:disabled)')).toHaveText(['gpt-5.2'])
    await control.getByRole('combobox', { name: 'Reasoning effort' }).selectOption('auto')
    await expect(control.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('auto')
    await control.getByRole('textbox', { name: 'Message Athena' }).fill('Draft survives restart')
    await expect.poll(async () => (await control.evaluate(() => window.athena!.getChat())).draft).toBe('Draft survives restart')
    await control.getByRole('textbox', { name: 'Search conversations' }).fill('authenticate')
    await expect(control.locator('.conversation-entry')).toHaveCount(1)
    await control.getByRole('textbox', { name: 'Search conversations' }).fill('')
    await control.screenshot({ path: 'test-results/conversation-system.png' })
    await app.close()
    app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
    await expect.poll(() => app.windows().length).toBe(3)
    control = app.windows().find((page) => page.url().includes('surface=control'))!
    await control.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(control.getByRole('textbox', { name: 'Message Athena' })).toHaveValue('Draft survives restart')
    expect((await control.evaluate(() => window.athena!.getChat())).sessions).toHaveLength(2)
    await control.evaluate((id) => window.athena!.chatSession({ action: 'switch', id }), first)
    const restored = await control.evaluate(() => window.athena!.getChat())
    expect(restored.messages[0].attachments).toHaveLength(4); expect(restored.config).toMatchObject({ model: 'gpt-5.2', effort: 'high' })
    expect(restored.workspaces?.[0].authorized).toBe(false)
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    expect((await control.evaluate((id) => window.athena!.chatSession({ action: 'delete', id }), first)).ok).toBe(false)
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    expect((await control.evaluate((id) => window.athena!.chatSession({ action: 'delete', id }), first)).ok).toBe(true)
    expect((await control.evaluate(() => window.athena!.getChat())).sessionId).toBe(second)
  } finally {
    await app.windows().find((page) => page.url().includes('surface=control'))?.evaluate(() => window.athena!.removeAIKey()).catch(() => {})
    await app.close()
  }
})
