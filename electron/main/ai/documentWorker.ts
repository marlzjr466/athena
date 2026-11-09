import { parentPort, workerData } from 'node:worker_threads'
import mammoth from 'mammoth'
import JSZip from 'jszip'

function checkArchive(bytes: Buffer): void {
  let expanded = 0, entries = 0
  for (let offset = 0; offset + 46 <= bytes.length; offset++) if (bytes.readUInt32LE(offset) === 0x02014b50) {
    expanded += bytes.readUInt32LE(offset + 24); entries++
    if (expanded > 24 * 1024 * 1024 || entries > 2000) throw new Error('Document expansion limit exceeded.')
  }
  if (!entries) throw new Error('Invalid document archive.')
}

function xmlValue(value: string): string {
  return value.replace(/&#(x[\da-f]+|\d+);|&(?:amp|lt|gt|quot|apos);/gi, (entity) => {
    if (entity.startsWith('&#')) {
      const code = entity[2]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(3, -1), 16) : Number.parseInt(entity.slice(2, -1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" } as Record<string, string>)[entity.toLowerCase()] ?? entity
  })
}

function inlineText(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => xmlValue(match[1])).join('')
}

async function spreadsheet(bytes: Buffer): Promise<string> {
  checkArchive(bytes)
  const zip = await JSZip.loadAsync(bytes)
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string')
  const shared = sharedXml ? [...sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((match) => inlineText(match[1])) : []
  const sheets = Object.keys(zip.files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path)).sort((a, b) => Number(a.match(/sheet(\d+)/)?.[1]) - Number(b.match(/sheet(\d+)/)?.[1])).slice(0, 50)
  if (!sheets.length) throw new Error('Spreadsheet has no worksheets.')
  let output = ''
  for (const path of sheets) {
    const xml = await zip.file(path)!.async('string')
    output += `\n${path.match(/sheet\d+/)?.[0] ?? 'Sheet'}\n`
    for (const row of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const address = cell[1].match(/\br="([^"]+)"/)?.[1] ?? ''
        const type = cell[1].match(/\bt="([^"]+)"/)?.[1]
        const raw = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? ''
        const value = type === 's' ? shared[Number(raw)] ?? '' : type === 'inlineStr' ? inlineText(cell[2]) : xmlValue(raw)
        if (value) cells.push(`${address}: ${value}`)
      }
      if (cells.length) output += `${cells.join(' | ')}\n`
      if (output.length > 120_000) return output
    }
  }
  return output
}

async function extract(): Promise<string> {
  const bytes = Buffer.from(workerData.bytes as Uint8Array)
  if (workerData.extension === '.docx') {
    // Bound ZIP expansion before the DOCX parser sees any compressed content.
    checkArchive(bytes)
    return (await mammoth.extractRawText({ buffer: bytes })).value
  }
  if (workerData.extension === '.xlsx') return spreadsheet(bytes)
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, verbosity: 0 })
  try {
    const pdf = await task.promise
    if (pdf.numPages > 100) throw new Error('PDFs are limited to 100 pages.')
    let text = ''
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      text += `\nPage ${pageNumber}\n${content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('')}\n`
      if (text.length > 120_000) break
      page.cleanup()
    }
    return text
  } finally { await task.destroy() }
}
async function image(): Promise<void> {
  const { loadImage, createCanvas } = await import('@napi-rs/canvas')
  const source = await loadImage(Buffer.from(workerData.bytes as Uint8Array))
  if (!source.width || !source.height || source.width * source.height > 32_000_000) throw new Error('Image too large.')
  const scale = Math.min(1, 2048 / Math.max(source.width, source.height))
  const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale))
  const canvas = createCanvas(width, height)
  canvas.getContext('2d').drawImage(source, 0, 0, width, height)
  parentPort?.postMessage({ png: await canvas.encode('png'), width, height })
}
if (workerData.extension === 'image') void image().catch(() => parentPort?.postMessage({ error: 'This image could not be decoded or exceeds 32 megapixels. Resize it and try again.' }))
else void extract().then((text) => parentPort?.postMessage({ text: text.slice(0, 120_000), truncated: text.length > 120_000 }), () => parentPort?.postMessage({ error: 'Could not extract this document. It may be damaged, encrypted, or over the 100-page/24 MB expanded limit.' }))
