import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'

test('previews image and spreadsheet attachments, switches files, downloads, and closes with Escape', async () => {
  test.setTimeout(60_000)
  const profile = await mkdtemp(join(tmpdir(), 'athena-viewer-e2e-'))
  const xlsx = new JSZip()
  xlsx.file('xl/sharedStrings.xml', '<sst><si><t>Athena spreadsheet preview</t></si></sst>')
  xlsx.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>')
  const spreadsheet = [...await xlsx.generateAsync({ type: 'uint8array' })]
  const docx = new JSZip()
  docx.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  docx.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  docx.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Athena Word preview</w:t></w:r></w:p></w:body></w:document>')
  const document = [...await docx.generateAsync({ type: 'uint8array' })]
  const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n5 0 obj<</Length 49>>stream\nBT /F1 12 Tf 20 100 Td (Athena PDF text) Tj ET\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF'
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ATHENA_TEST_DATA: profile } })
  try {
    let control = await app.firstWindow()
    await expect.poll(async () => {
      for (const window of app.windows()) {
        if (await window.getByRole('button', { name: 'Conversation', exact: true }).count().catch(() => 0)) { control = window; return true }
      }
      return false
    }).toBe(true)
    await control.getByRole('button', { name: 'Conversation', exact: true }).click()
    await control.evaluate(() => window.athena!.setPermissionEnabled({ permission: 'personalFiles', enabled: true }))
    const sessionId = (await control.evaluate(() => window.athena!.getChat())).sessionId!
    const png = await app.evaluate(({ nativeImage }) => [...nativeImage.createFromBitmap(Buffer.alloc(1600 * 900 * 4, 255), { width: 1600, height: 900 }).toPNG()])
    expect((await control.evaluate(({ sessionId, png }) => window.athena!.chatContext({ action: 'import', sessionId, name: 'image.png', bytes: new Uint8Array(png) }), { sessionId, png })).ok).toBe(true)
    expect((await control.evaluate(({ sessionId, spreadsheet }) => window.athena!.chatContext({ action: 'import', sessionId, name: 'budget.xlsx', bytes: new Uint8Array(spreadsheet) }), { sessionId, spreadsheet })).ok).toBe(true)
    expect((await control.evaluate(({ sessionId, document }) => window.athena!.chatContext({ action: 'import', sessionId, name: 'report.docx', bytes: new Uint8Array(document) }), { sessionId, document })).ok).toBe(true)
    expect((await control.evaluate(({ sessionId, pdf }) => window.athena!.chatContext({ action: 'import', sessionId, name: 'report.pdf', bytes: new TextEncoder().encode(pdf) }), { sessionId, pdf })).ok).toBe(true)
    expect((await control.evaluate(({ sessionId }) => window.athena!.chatContext({ action: 'import', sessionId, name: 'notes.md', bytes: new TextEncoder().encode('# Athena Markdown preview') }), { sessionId })).ok).toBe(true)
    await expect(control.getByRole('button', { name: 'Preview image.png' })).toBeVisible()
    await control.getByRole('button', { name: 'Preview image.png' }).click()
    const dialog = control.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-label', 'Preview image.png')
    const stage = control.getByRole('region', { name: 'image.png preview' })
    const image = stage.getByRole('img', { name: 'image.png' })
    await expect.poll(async () => image.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(100)
    const fit = await stage.evaluate((node) => {
      const frame = node.getBoundingClientRect()
      const picture = node.querySelector('img')!.getBoundingClientRect()
      return { left: picture.left - frame.left, right: frame.right - picture.right, top: picture.top - frame.top, bottom: frame.bottom - picture.bottom }
    })
    expect(Math.min(...Object.values(fit))).toBeGreaterThanOrEqual(149)
    await dialog.getByRole('button', { name: 'Zoom in' }).click()
    const zoomed = await stage.evaluate((node) => {
      const frame = node.getBoundingClientRect()
      const picture = node.querySelector('img')!.getBoundingClientRect()
      return { offsetX: Math.abs((picture.left + picture.right) / 2 - (frame.left + frame.right) / 2), offsetY: Math.abs((picture.top + picture.bottom) / 2 - (frame.top + frame.bottom) / 2), overflow: getComputedStyle(node).overflow }
    })
    expect(zoomed.offsetX).toBeLessThan(1)
    expect(zoomed.offsetY).toBeLessThan(1)
    expect(zoomed.overflow).toBe('hidden')
    await expect(dialog.getByRole('navigation', { name: 'Attachments' }).getByRole('button')).toHaveCount(5)
    await dialog.getByRole('button', { name: 'Show budget.xlsx' }).click()
    await expect(control.getByRole('region', { name: 'budget.xlsx preview' })).toContainText('A1: Athena spreadsheet preview | B1: 42')
    await dialog.getByRole('button', { name: 'Show report.docx' }).click()
    await expect(control.getByRole('region', { name: 'report.docx preview' })).toContainText('Athena Word preview')
    await dialog.getByRole('button', { name: 'Show report.pdf' }).click()
    await expect(control.getByRole('region', { name: 'report.pdf preview' })).toContainText('Athena PDF text')
    await dialog.getByRole('button', { name: 'Show notes.md' }).click()
    await expect(control.getByRole('region', { name: 'notes.md preview' })).toContainText('# Athena Markdown preview')
    await dialog.getByRole('button', { name: 'Show budget.xlsx' }).click()
    const destination = join(profile, 'saved-budget.xlsx')
    await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }) }, destination)
    await control.getByRole('button', { name: 'Download attachment' }).click()
    await expect.poll(async () => (await readFile(destination)).length).toBeGreaterThan(0)
    await control.keyboard.press('Escape')
    await expect(control.getByRole('dialog')).toHaveCount(0)
  } finally { await app.close() }
})
