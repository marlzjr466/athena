import { z } from 'zod'
import JSZip from 'jszip'
import type { ProjectTools } from './AIProvider'
import { ChatError } from './AIProvider'
import type { ArtifactService } from './artifactService'

const inputSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(160),
  content: z.string().max(8_000_000),
}).strict()
const allowed = /^(?:text\/(?:plain|markdown|html|csv|yaml|xml|typescript|x-python)|application\/(?:json|javascript|zip|vnd\.openxmlformats-officedocument\.(?:wordprocessingml\.document|spreadsheetml\.sheet)))|image\/svg\+xml$/i
const pdfMime = 'application/pdf'
const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const zipMime = 'application/zip'
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
function pdf(content: string): Uint8Array {
  const text = content.replace(/[\\()\r\n]/g, (value) => value === '\\' ? '\\\\' : value === '(' ? '\\(' : value === ')' ? '\\)' : ' ')
  const stream = `BT /F1 10 Tf 48 760 Td (${text.slice(0, 7000)}) Tj ET`
  const objects = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]
  let output = '%PDF-1.4\n', offsets: number[] = [0]
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
  const xref = Buffer.byteLength(output); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new TextEncoder().encode(output)
}
async function structuredPackage(mimeType: string, content: string): Promise<Uint8Array> {
  const zip = new JSZip()
  if (mimeType === zipMime) { zip.file('content.txt', content); return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) }
  if (mimeType === docxMime) {
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
    const paragraphs = content.split(/\r?\n/).map((line) => `<w:p><w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`).join('')
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`)
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  }
  const rows = content.split(/\r?\n/).map((line, row) => `<row r="${row + 1}"><c r="A${row + 1}" t="inlineStr"><is><t>${xml(line)}</t></is></c></row>`).join('')
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Athena" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export function createArtifactTools(service: ArtifactService, active: () => boolean, beforeAction?: (name: string, input: unknown, signal: AbortSignal) => Promise<void>): ProjectTools {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(inputSchema)
  return {
    definitions: [{ name: 'create_artifact', description: 'Create a real local downloadable text, code, SVG, PDF, DOCX, XLSX or ZIP artifact. Do not claim a file was created unless this tool returns success. PPTX/video and rendered images require a separately configured generator and are unavailable here.', parameters }],
    assertAccess: () => { if (!active()) throw new ChatError('The conversation changed. Artifact creation stopped.') },
    parallelSafe: () => false,
    async execute(name, input, signal) {
      if (name !== 'create_artifact') return JSON.stringify({ error: 'Unknown artifact tool.' })
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) return JSON.stringify({ error: 'Artifact requires name, MIME type and content.' })
      if (!allowed.test(parsed.data.mimeType) && parsed.data.mimeType !== pdfMime) return JSON.stringify({ error: 'Unsupported artifact format. Athena currently creates text, Markdown, HTML, CSV, JSON, YAML, code, SVG, PDF, DOCX, XLSX and ZIP files.' })
      await beforeAction?.(name, parsed.data, signal); if (!active()) throw new ChatError('The conversation changed. Artifact creation stopped.'); signal.throwIfAborted()
      const bytes = parsed.data.mimeType === pdfMime ? pdf(parsed.data.content) : [docxMime, xlsxMime, zipMime].includes(parsed.data.mimeType) ? await structuredPackage(parsed.data.mimeType, parsed.data.content) : new TextEncoder().encode(parsed.data.content)
      const artifact = await service.store(parsed.data.name, parsed.data.mimeType, bytes)
      return JSON.stringify({ artifact, savedLocally: true, downloadAction: 'Use the Download button shown with this response.' })
    },
  }
}
