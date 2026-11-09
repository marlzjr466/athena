import { posix } from 'node:path'
import { ChatError } from './AIProvider'

export interface SourceSyntax { path: string; status: 'passed' | 'unsupported'; validator: string; errors: string[] }

/** Syntax only: never loads project configuration, resolves imports, or runs code. */
export async function checkSourceSyntax(path: string, content: string): Promise<SourceSyntax> {
  const result: SourceSyntax = { path, status: 'unsupported', validator: 'No built-in syntax validator for this format', errors: [] }
  if (/\.json$/i.test(path)) {
    result.status = 'passed'; result.validator = 'JSON parser'
    try { JSON.parse(content.replace(/^\uFEFF/, '')) } catch (error) { result.errors.push(String(error)) }
  } else if (/\.[cm]?[jt]sx?$/i.test(path)) {
    const ts = await import('typescript')
    const kind = /\.tsx$/i.test(path) ? ts.ScriptKind.TSX : /\.jsx$/i.test(path) ? ts.ScriptKind.JSX : /\.[cm]?ts$/i.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind)
    const diagnostics = (source as typeof source & { parseDiagnostics: readonly import('typescript').DiagnosticWithLocation[] }).parseDiagnostics
    result.status = 'passed'; result.validator = 'TypeScript/JavaScript syntax parser (no project type check)'
    for (const diagnostic of diagnostics.slice(0, 8)) {
      const location = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
      result.errors.push(`${path}:${location.line + 1}:${location.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
    }
    const strip = (value: string) => value.replace(/\.[cm]?[jt]sx?$/i, '')
    for (const statement of source.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const ref = statement.moduleSpecifier.text
        if (ref.startsWith('.') && strip(posix.normalize(posix.join(posix.dirname(path), ref))) === strip(path)) result.errors.push(`${path}: self-import/re-export ${JSON.stringify(ref)} is not allowed in a generated file.`)
      }
    }
  }
  return result
}

export function requireValidSource(result: SourceSyntax): void {
  if (result.errors.length) throw new ChatError(`Source validation failed before approval; no file was written.\n${result.errors.join('\n')}`)
}
