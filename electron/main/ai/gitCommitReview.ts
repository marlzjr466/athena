import type { ChangePreview } from '../../../shared/agent'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { ChatError } from './AIProvider'
import type { AgentCommands, CommandRequest, CommandResult } from './agentCommands'
import { sensitiveContent, sensitivePath } from './workspaceService'

const MAX_REVIEW_CHUNK = 45_000
const MAX_STAGED_DIFF_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_STAGED_DIFF_BYTES = 32 * 1024 * 1024
const gitBase = ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'credential.helper=']
type GitRunner = Pick<AgentCommands, 'execute'>
export interface StagedFileReview { path: string; status: 'complete' | 'incomplete'; contentHash: string; chunkHashes: string[] }
export interface StagedCommitReview { root: string; branch: string; indexIdentity: string; reviewHash: string; fileReviews: StagedFileReview[]; changes: ChangePreview[]; summary: string }

function failure(operation: string, result: CommandResult, path?: string): never {
  const reason = result.timedOut ? 'timed out' : result.truncated ? 'output exceeded the review limit' :
    `exit ${result.exitCode ?? 'unknown'}${(result.stderr ?? result.output).trim() ? `: ${(result.stderr ?? result.output).trim().slice(0, 500)}` : ''}`
  const target = path ? ` for ${JSON.stringify(path)}` : ''
  console.warn('[git-commit-review]', operation, path ? JSON.stringify(path) : '', reason)
  throw new ChatError(`Commit blocked: Git ${operation}${target} failed (${reason}). Staged changes were left untouched.`)
}

async function git(runner: GitRunner, root: string, operation: string, args: string[], signal: AbortSignal, path?: string): Promise<string> {
  const request: CommandRequest = { executable: 'git', args: [...gitBase, ...args], network: false, install: false, gitWrite: false }
  let result: CommandResult
  try { result = await runner.execute(root, request, signal) }
  catch (error) {
    const reason = error instanceof ChatError ? error.userMessage : 'Git could not be started.'
    console.warn('[git-commit-review]', operation, path ? JSON.stringify(path) : '', reason)
    throw new ChatError(`Commit blocked: Git ${operation}${path ? ` for ${JSON.stringify(path)}` : ''} could not run (${reason}). Staged changes were left untouched.`)
  }
  if (result.exitCode !== 0 || result.truncated || result.timedOut) failure(operation, result, path)
  // Git may emit working-tree permission warnings on stderr while returning 0.
  // Index plumbing is parsed only from stdout, never from the merged terminal log.
  return result.stdout ?? result.output
}

async function gitStream(runner: GitRunner, root: string, operation: string, args: string[], signal: AbortSignal, path: string): Promise<string> {
  const request: CommandRequest = { executable: 'git', args: [...gitBase, ...args], network: false, install: false, gitWrite: false, streamOutput: true }
  let streamed = '', received = false
  let result: CommandResult
  try {
    result = await runner.execute(root, request, signal, chunk => {
      received = true
      streamed += chunk
    })
  } catch (error) {
    if (error instanceof ChatError) throw error
    throw new ChatError(`Commit blocked: Git ${operation} for ${JSON.stringify(path)} could not stream the complete staged diff. Staged changes were left untouched.`)
  }
  if (result.exitCode !== 0 || result.truncated || result.timedOut) failure(operation, result, path)
  // Small test/custom runners may not implement streamed callbacks.
  const diff = received ? streamed : result.stdout ?? result.output
  if (Buffer.byteLength(diff) > MAX_STAGED_DIFF_BYTES) throw new ChatError(`Commit blocked: staged diff for ${JSON.stringify(path)} exceeds the complete-review safety limit. No content was skipped and staged changes were left untouched.`)
  return diff
}

function sha256(text: string): string { return createHash('sha256').update(text).digest('hex') }

function diffChunks(path: string, diff: string): string[] {
  if (diff.length <= MAX_REVIEW_CHUNK) return [diff]
  const lines = diff.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const hunkPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*?)(?:\r?\n)?$/
  const firstHunk = lines.findIndex(line => hunkPattern.test(line))
  if (firstHunk < 0) throw new ChatError(`Commit blocked: staged diff for ${JSON.stringify(path)} is oversized and has no safe hunk boundaries. The file was not reviewed.`)
  const preamble = lines.slice(0, firstHunk).join('')
  if (preamble.length >= MAX_REVIEW_CHUNK / 2) throw new ChatError(`Commit blocked: staged diff metadata for ${JSON.stringify(path)} is too large to preserve in every review chunk.`)
  const output: string[] = []
  let cursor = firstHunk
  while (cursor < lines.length) {
    const match = hunkPattern.exec(lines[cursor])
    if (!match) throw new ChatError(`Commit blocked: staged diff for ${JSON.stringify(path)} has malformed hunk structure and cannot be fully reviewed.`)
    const oldStart = Number(match[1]), oldCount = match[2] === undefined ? 1 : Number(match[2])
    const newStart = Number(match[3]), newCount = match[4] === undefined ? 1 : Number(match[4])
    const suffix = match[5] ?? ''
    const bodyStart = ++cursor
    while (cursor < lines.length && !hunkPattern.test(lines[cursor])) cursor++
    const body = lines.slice(bodyStart, cursor)
    if (!body.length) throw new ChatError(`Commit blocked: staged diff for ${JSON.stringify(path)} contains an empty hunk.`)
    const positions: Array<{ old: number; current: number }> = []
    let oldLine = oldStart, newLine = newStart
    for (const line of body) {
      positions.push({ old: oldLine, current: newLine })
      if (line.startsWith(' ') || line.startsWith('-')) oldLine++
      if (line.startsWith(' ') || line.startsWith('+')) newLine++
      if (!/^[ +\\-]/.test(line)) throw new ChatError(`Commit blocked: staged diff for ${JSON.stringify(path)} contains an unrecognized hunk line.`)
    }
    const countedOld = body.filter(line => line.startsWith(' ') || line.startsWith('-')).length
    const countedNew = body.filter(line => line.startsWith(' ') || line.startsWith('+')).length
    if (countedOld !== oldCount || countedNew !== newCount) throw new ChatError(`Commit blocked: staged diff hunk counts for ${JSON.stringify(path)} are incomplete. The file was not reviewed.`)
    let start = 0
    while (start < body.length) {
      let end = start, chars = preamble.length + 120
      while (end < body.length && chars + body[end].length <= MAX_REVIEW_CHUNK) { chars += body[end].length; end++ }
      if (end === start) throw new ChatError(`Commit blocked: ${JSON.stringify(path)} has a single diff line too large to display safely. The file was not reviewed.`)
      const selected = body.slice(start, end)
      const oldLines = selected.filter(line => line.startsWith(' ') || line.startsWith('-')).length
      const newLines = selected.filter(line => line.startsWith(' ') || line.startsWith('+')).length
      const oldRangeStart = positions[start].old, newRangeStart = positions[start].current
      const hunk = `@@ -${oldRangeStart},${oldLines} +${newRangeStart},${newLines} @@${suffix}\n`
      output.push(`${preamble}${hunk}${selected.join('')}`)
      if (end >= body.length) break
      // Repeat up to three nearby context lines, never added/removed content,
      // so a boundary stays readable without duplicating a reviewed change.
      let nextStart = end
      while (nextStart > start && end - nextStart < 3 && body[nextStart - 1].startsWith(' ')) nextStart--
      start = nextStart
    }
  }
  if (!output.length || output.some(chunk => !chunk.length || chunk.length > MAX_REVIEW_CHUNK)) throw new ChatError(`Commit blocked: staged diff for ${JSON.stringify(path)} could not be divided into complete review chunks.`)
  return output
}

export function assertCompleteStagedReview(review: StagedCommitReview): void {
  const changesByPath = new Map<string, ChangePreview[]>()
  for (const change of review.changes) {
    const entries = changesByPath.get(change.path) ?? []
    entries.push(change); changesByPath.set(change.path, entries)
  }
  if (!review.fileReviews.length || review.fileReviews.some(file => file.status !== 'complete' || !file.chunkHashes.length)) throw new ChatError('Commit blocked: at least one staged file review is incomplete.')
  if (changesByPath.size !== review.fileReviews.length) throw new ChatError('Commit blocked: the displayed diff chunks do not match the reviewed staged files.')
  for (const file of review.fileReviews) {
    const changes = changesByPath.get(file.path) ?? []
    if (changes.length !== file.chunkHashes.length || file.chunkHashes.some((hash, index) => {
      const change = changes[index]
      return !change || change.reviewChunk?.status !== 'complete' || change.reviewChunk.fileHash !== file.contentHash || change.reviewChunk.chunkHash !== hash || change.reviewChunk.index !== index + 1 || change.reviewChunk.total !== file.chunkHashes.length || sha256(change.diff) !== hash
    })) throw new ChatError(`Commit blocked: one or more review chunks for ${JSON.stringify(file.path)} are missing, changed, or incomplete.`)
  }
  const expected = sha256(JSON.stringify({ root: review.root, branch: review.branch, indexIdentity: review.indexIdentity, files: review.fileReviews }))
  if (expected !== review.reviewHash) throw new ChatError('Commit blocked: the aggregate staged review hash is invalid. Review the staged changes again.')
}

/** Re-read only the affected staged file, verify its aggregate hash is unchanged, and repair one failed preview chunk. */
export async function retryStagedReviewChunk(runner: GitRunner, review: StagedCommitReview, path: string, chunkIndex: number, signal: AbortSignal): Promise<void> {
  const file = review.fileReviews.find(entry => entry.path === path)
  const changePosition = review.changes.findIndex(entry => entry.path === path && entry.reviewChunk?.index === chunkIndex)
  const failed = review.changes[changePosition]
  if (!file || !failed?.reviewChunk || failed.reviewChunk.status !== 'incomplete') throw new ChatError(`Commit review retry blocked: ${JSON.stringify(path)} chunk ${chunkIndex} is not a pending failed chunk.`)
  const identityBefore = await git(runner, review.root, 'staged index recheck before chunk retry', ['diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '-z'], signal)
  if (identityBefore !== review.indexIdentity) throw new ChatError('Commit review retry blocked: the staged index changed. Reinspect the staged changes.')
  const diff = await gitStream(runner, review.root, 'staged diff retry', ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--unified=3', '--', `:(literal)${path}`], signal, path)
  if (diff.includes('[REDACTED]') || sensitiveContent(diff) || /\b(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{20,}\b/.test(diff) || diff.includes('GIT binary patch') || /\bBinary files .* differ\b/.test(diff)) throw new ChatError(`Commit review retry blocked: staged file ${JSON.stringify(path)} contains possible credentials or binary content.`)
  if (sha256(diff) !== file.contentHash) throw new ChatError(`Commit review retry blocked: staged content for ${JSON.stringify(path)} changed. Review the new staged content.`)
  const chunks = diffChunks(path, diff), hashes = chunks.map(sha256)
  if (hashes.length !== file.chunkHashes.length || hashes[chunkIndex - 1] !== failed.reviewChunk.chunkHash) throw new ChatError(`Commit review retry blocked: chunk boundaries for ${JSON.stringify(path)} changed. Rebuild the complete staged review.`)
  const identityAfter = await git(runner, review.root, 'staged index recheck after chunk retry', ['diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '-z'], signal)
  if (identityAfter !== review.indexIdentity) throw new ChatError('Commit review retry blocked: the staged index changed while retrying a chunk. Reinspect the staged changes.')
  review.changes[changePosition] = { ...failed, diff: chunks[chunkIndex - 1], reviewChunk: { ...failed.reviewChunk, status: 'complete' } }
  assertCompleteStagedReview(review)
}

function stagedPaths(output: string): string[] {
  const paths = output.split('\0').filter(Boolean)
  for (const path of paths) {
    if (path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.') || path.includes('\\') || path.includes('[REDACTED]')) {
      throw new ChatError(`Commit blocked: staged path ${JSON.stringify(path)} cannot be safely identified. Staged changes were left untouched.`)
    }
  }
  return paths
}

function stagedMetadata(statusOutput: string, statsOutput: string): { paths: string[]; summary: string } {
  const statuses = statusOutput.split('\0').filter(Boolean)
  if (statuses.length % 2) throw new ChatError('Commit blocked: Git returned an incomplete staged status list.')
  const paths: string[] = []
  for (let index = 0; index < statuses.length; index += 2) {
    if (!/^[AMDT]$/.test(statuses[index])) throw new ChatError(`Commit blocked: unsupported staged status ${JSON.stringify(statuses[index])}.`)
    paths.push(statuses[index + 1])
  }
  stagedPaths(paths.join('\0'))
  const stats = statsOutput.split('\0').filter(Boolean)
  if (stats.length !== paths.length) throw new ChatError('Commit blocked: Git staged file statistics do not match staged statuses.')
  let added = 0, deleted = 0
  for (let index = 0; index < stats.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(stats[index])
    if (!match || match[3] !== paths[index]) throw new ChatError(`Commit blocked: staged statistics could not be matched to ${JSON.stringify(paths[index])}.`)
    if (match[1] === '-' || match[2] === '-') throw new ChatError(`Commit blocked: staged file ${JSON.stringify(paths[index])} is binary and cannot be reviewed safely.`)
    added += Number(match[1]); deleted += Number(match[2])
  }
  return { paths, summary: `${paths.length} files · +${added} −${deleted}` }
}

export async function inspectStagedCommit(runner: GitRunner, root: string, signal: AbortSignal): Promise<StagedCommitReview> {
  const actualRoot = (await git(runner, root, 'repository check', ['rev-parse', '--show-toplevel'], signal)).trim()
  if (actualRoot !== realpathSync(root)) throw new ChatError(`Commit blocked: selected project ${JSON.stringify(root)} is not the Git root ${JSON.stringify(actualRoot)}.`)
  const branch = (await git(runner, root, 'branch check', ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)).trim()
  const conflicts = await git(runner, root, 'conflict check', ['ls-files', '-u', '-z'], signal)
  if (conflicts) throw new ChatError('Commit blocked: the Git index has unresolved merge conflicts. Resolve them before committing.')
  const indexIdentity = await git(runner, root, 'staged index identity', ['diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '-z'], signal)
  const statusOutput = await git(runner, root, 'staged status listing', ['diff', '--cached', '--name-status', '--no-renames', '-z'], signal)
  const statsOutput = await git(runner, root, 'staged change statistics', ['diff', '--cached', '--numstat', '--no-renames', '-z'], signal)
  const { paths, summary } = stagedMetadata(statusOutput, statsOutput)
  if (!paths.length || !indexIdentity) throw new ChatError('Commit blocked: there are no staged changes to commit.')
  const changes: ChangePreview[] = [], fileReviews: StagedFileReview[] = []
  let totalDiffBytes = 0
  for (const path of paths) {
    if (sensitivePath(path)) throw new ChatError(`Commit blocked: staged file ${JSON.stringify(path)} is credential-sensitive. Review and remove it from the index manually if unintended.`)
    // Literal pathspecs prevent a staged filename containing Git wildcards from
    // making us review a different set of paths. All content comes from the index.
    const diff = await gitStream(runner, root, 'staged diff inspection', ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--unified=3', '--', `:(literal)${path}`], signal, path)
    if (!diff) throw new ChatError(`Commit blocked: staged file ${JSON.stringify(path)} returned no reviewable diff.`)
    totalDiffBytes += Buffer.byteLength(diff)
    if (totalDiffBytes > MAX_TOTAL_STAGED_DIFF_BYTES) throw new ChatError('Commit blocked: the complete staged diff exceeds Athena’s aggregate review safety limit. No content was skipped and staged changes were left untouched.')
    if (diff.includes('[REDACTED]') || sensitiveContent(diff) || /\b(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{20,}\b/.test(diff) || diff.includes('GIT binary patch') || /\bBinary files .* differ\b/.test(diff)) throw new ChatError(`Commit blocked: staged file ${JSON.stringify(path)} contains possible credentials or binary content that cannot be reviewed safely. Staged changes were left untouched.`)
    const contentHash = sha256(diff), chunks = diffChunks(path, diff), chunkHashes = chunks.map(sha256)
    fileReviews.push({ path, status: 'complete', contentHash, chunkHashes })
    chunks.forEach((chunk, index) => changes.push({ id: `git-staged-${changes.length}`, path, diff: chunk, status: 'proposed', reviewChunk: { fileHash: contentHash, chunkHash: chunkHashes[index], index: index + 1, total: chunks.length, status: 'complete' } }))
  }
  const afterReview = await git(runner, root, 'staged index recheck', ['diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '-z'], signal)
  if (afterReview !== indexIdentity) throw new ChatError('Commit blocked: the staged index changed during review. Review the new staged state before committing.')
  const review: StagedCommitReview = { root, branch, indexIdentity, reviewHash: '', fileReviews, changes, summary }
  review.reviewHash = sha256(JSON.stringify({ root, branch, indexIdentity, files: fileReviews }))
  assertCompleteStagedReview(review)
  return review
}

export async function assertStagedCommitUnchanged(runner: GitRunner, review: StagedCommitReview, signal: AbortSignal): Promise<void> {
  assertCompleteStagedReview(review)
  const root = (await git(runner, review.root, 'repository recheck', ['rev-parse', '--show-toplevel'], signal)).trim()
  const branch = (await git(runner, review.root, 'branch recheck', ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)).trim()
  const identity = await git(runner, review.root, 'staged index recheck', ['diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '-z'], signal)
  if (root !== realpathSync(review.root) || branch !== review.branch || identity !== review.indexIdentity) throw new ChatError('Commit blocked: repository, branch, or staged index changed during approval. Review the staged changes again. No commit was created.')
  const refreshed = await inspectStagedCommit(runner, review.root, signal)
  if (refreshed.reviewHash !== review.reviewHash) throw new ChatError('Commit blocked: the staged diff hash changed during approval. Review the new staged content before committing.')
}
