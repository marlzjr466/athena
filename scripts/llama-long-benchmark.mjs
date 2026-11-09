import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'

const modelPath = '/Users/mariojrlangomez/.ollama/models/blobs/sha256-4a188102020e9c9530b687fd6400f775c45e90a0d7baafe65bd0a36963fbb7ba'
const tokenize = '/opt/homebrew/bin/llama-tokenize'
const serverBin = '/opt/homebrew/bin/llama-server'
const cli = '/opt/homebrew/bin/llama-cli'
const port = 18080
const host = '127.0.0.1'
const outDir = '/tmp/athena-llama'
const reportPath = `${homedir()}/Library/Application Support/Athena/llama-context-validation.json`
const needles = { start: 'NEEDLESTART7F3C', middle: 'NEEDLEMIDDLE91E2', end: 'NEEDLEEND44AB' }
const levels = [
  { id: 'standard', tokens: 32768, factor: null },
  { id: 'extended', tokens: 65536, factor: 2 },
  { id: 'long', tokens: 131072, factor: 4 },
  { id: 'experimental', tokens: 196608, factor: 6 },
  { id: 'maximum', tokens: 250000, factor: 250000 / 32768 },
]

mkdirSync(outDir, { recursive: true })

function metal() {
  const text = spawnSync(cli, ['--list-devices'], { encoding: 'utf8' }).stdout
  const match = text.match(/MTL0:\s*(.*?)\((\d+)\s+MiB,\s*(\d+)\s+MiB free\)/)
  return match ? { name: match[1].trim(), totalMiB: Number(match[2]), freeMiB: Number(match[3]) } : { name: null, totalMiB: null, freeMiB: null, raw: text }
}

function neededMiB(tokens) {
  const kv = (18432 * tokens) / (1024 * 1024)
  return kv + (1923946496 / (1024 * 1024)) + (1.5 * 1024)
}

function countTokens(text) {
  const result = spawnSync(tokenize, ['-m', modelPath, '--stdin', '--show-count', '--no-bos', '--no-parse-special', '--log-disable'], { input: text, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000 })
  const match = `${result.stdout}\n${result.stderr}`.match(/Total number of tokens:\s*(\d+)/)
  return match ? Number(match[1]) : null
}

function buildPrompt(target) {
  const sample = Array.from({ length: 4000 }, (_, index) => `pad${index}`).join(' ')
  const sampleCount = countTokens(sample)
  if (!sampleCount) throw new Error('Tokenizer did not return a count')
  let count = Math.max(1000, Math.floor((target - 80) / (sampleCount / 4000)))
  let text = ''
  let tokens = 0
  for (let attempt = 0; attempt < 4; attempt++) {
    const words = Array.from({ length: count }, (_, index) => `pad${index}`)
    words[0] = needles.start
    words[Math.floor(words.length / 2)] = needles.middle
    words[words.length - 1] = needles.end
    text = `${words.join(' ')}\nReply with exactly these three tokens, one per line, and no other words:\n${needles.start}\n${needles.middle}\n${needles.end}`
    tokens = countTokens(text) ?? 0
    if (tokens >= target - 700 && tokens <= target - 200) break
    count = Math.max(1000, Math.floor(count * ((target - 400) / Math.max(tokens, 1))))
  }
  return { text, tokens }
}

function startServer(level, logPath) {
  const args = ['-m', modelPath, '--host', host, '--port', String(port), '-c', String(level.tokens), '-ngl', 'all', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '-np', '1', '--jinja', '-n', '64']
  if (level.factor) args.push('--rope-scaling', 'yarn', '--rope-scale', String(level.factor), '--yarn-orig-ctx', '32768')
  const fd = openSync(logPath, 'w')
  return spawn(serverBin, args, { stdio: ['ignore', fd, fd] })
}

async function waitHealth(timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://${host}:${port}/health`)
      if (response.ok) return true
    } catch { /* server still loading */ }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

function chat(messages, maxTokens, timeoutMs) {
  const body = JSON.stringify({ model: 'qwen2.5-coder-3b-long', temperature: 0, max_tokens: maxTokens, stream: false, messages })
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: host, port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = {}
        try { parsed = JSON.parse(text) } catch { reject(new Error(`Unreadable llama.cpp response (${res.statusCode})`)); return }
        if ((res.statusCode ?? 500) >= 400) reject(new Error(parsed?.error?.message || `HTTP ${res.statusCode}`))
        else resolve(parsed)
      })
    })
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('chat timed out')) })
    req.on('error', reject)
    req.end(body)
  })
}

function rss(pid) {
  const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
  const value = Number(result.stdout.trim())
  return Number.isFinite(value) ? value * 1024 : null
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function stop(pid) {
  if (!pid || !alive(pid)) return
  try { process.kill(pid, 'SIGTERM') } catch { return }
  const started = Date.now()
  while (alive(pid) && Date.now() - started < 20_000) spawnSync('sleep', ['0.25'])
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
}

const versionResult = spawnSync(serverBin, ['--version'], { encoding: 'utf8' })
const version = `${versionResult.stdout}\n${versionResult.stderr}`.trim()
const from = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : null
const fromIndex = from ? levels.findIndex((level) => level.id === from) : 0
if (fromIndex < 0) throw new Error(`Unknown benchmark level ${from}`)
const priorPath = `${outDir}/benchmark.partial.json`
const prior = fromIndex > 0 && exists(priorPath) ? JSON.parse(readFileSync(priorPath, 'utf8')) : []
const results = prior.filter((row) => row.passed && levels.findIndex((level) => level.id === row.id) < fromIndex)
console.log(version)

function exists(path) {
  try { readFileSync(path); return true } catch { return false }
}

for (const level of levels) {
  if (levels.findIndex((entry) => entry.id === level.id) < fromIndex) continue
  const device = metal()
  const need = neededMiB(level.tokens)
  const row = { id: level.id, requestedTokens: level.tokens, yarnFactor: level.factor, loaded: false, passed: false, metal: device, estimatedNeedMiB: Math.round(need) }
  if (device.freeMiB == null || device.freeMiB < need * 1.4 || device.freeMiB < 4096) {
    row.error = `Skipped. Metal free memory is ${device.freeMiB ?? 'unknown'} MiB and this window needs about ${Math.round(need)} MiB before a safety margin.`
    results.push(row)
    console.log(row.error)
    break
  }
  console.log(`building prompt for ${level.id}`)
  const prompt = buildPrompt(level.tokens)
  row.constructedTokens = prompt.tokens
  const logPath = `${outDir}/${level.id}.log`
  const child = startServer(level, logPath)
  const pid = child.pid
  const timeout = level.tokens <= 32768 ? 240000 : level.tokens <= 65536 ? 480000 : level.tokens <= 131072 ? 1_200_000 : 2_400_000
  try {
    row.loaded = await waitHealth(180000) && child.exitCode == null
    if (!row.loaded) {
      row.error = child.exitCode != null ? 'llama-server exited before the test.' : 'llama-server did not become healthy.'
      results.push(row)
      console.log(row.error)
      stop(pid)
      break
    }
    const models = await (await fetch(`http://${host}:${port}/v1/models`)).json()
    row.allocatedTokens = models?.data?.[0]?.meta?.n_ctx ?? null
    if (row.allocatedTokens == null || row.allocatedTokens < level.tokens) {
      row.loaded = false
      row.error = `Server allocated ${row.allocatedTokens ?? 'no'} context, below ${level.tokens}.`
      results.push(row)
      console.log(row.error)
      stop(pid)
      break
    }
    row.processRssBytes = rss(pid)
    const first = await chat([
      { role: 'system', content: 'Follow the user instruction exactly.' },
      { role: 'user', content: prompt.text },
    ], 48, timeout)
    const answer = first.choices?.[0]?.message?.content ?? ''
    row.promptTokens = first.usage?.prompt_tokens ?? null
    row.generatedTokens = first.usage?.completion_tokens ?? null
    row.promptPerSecond = first.timings?.prompt_per_second ?? null
    row.generationPerSecond = first.timings?.predicted_per_second ?? null
    row.retrieval = { start: answer.includes(needles.start), middle: answer.includes(needles.middle), end: answer.includes(needles.end) }
    row.answer = answer.slice(0, 400)
    const second = await chat([
      { role: 'system', content: 'Follow the user instruction exactly.' },
      { role: 'user', content: prompt.text },
      { role: 'assistant', content: answer },
      { role: 'user', content: 'Reply with only the middle needle token from the original passage.' },
    ], 16, timeout)
    const follow = second.choices?.[0]?.message?.content ?? ''
    row.multiTurnMiddle = follow.includes(needles.middle)
    row.followUp = follow.slice(0, 200)
    row.cachedTokens = second.usage?.prompt_tokens_details?.cached_tokens ?? null
    row.processRssBytes = rss(pid)
    row.kvCacheBytes = 18432 * (row.promptTokens ?? level.tokens)
    row.kvCacheNote = 'q8_0 size from the Qwen2.5-3B geometry (36 layers, 2 KV heads, head dim 128). This is the cache width the server was started with, not an OS measurement.'
    const longEnough = (row.promptTokens ?? 0) >= Math.floor(level.tokens * 0.5)
    row.passed = row.loaded && row.allocatedTokens >= level.tokens && longEnough && row.retrieval.start && row.retrieval.middle && row.retrieval.end
    console.log(JSON.stringify({ id: row.id, loaded: row.loaded, allocated: row.allocatedTokens, prompt: row.promptTokens, retrieval: row.retrieval, multiTurn: row.multiTurnMiddle, passed: row.passed, rss: row.processRssBytes }))
  } catch (error) {
    row.error = error instanceof Error ? error.message : 'Benchmark request failed'
    console.log(row.error)
  } finally {
    stop(pid)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  results.push(row)
  writeFileSync(`${outDir}/benchmark.partial.json`, JSON.stringify(results, null, 2))
  if (!row.loaded) break
}

const passed = results.filter((row) => row.passed).map((row) => row.requestedTokens)
const report = {
  runtime: { executable: serverBin, version, fingerprint: 'b11429-d81235049', commit: 'd81235049', build: '11429' },
  model: { id: 'llama.cpp:qwen2.5-coder-3b', gguf: modelPath, family: 'qwen2', quantization: 'Q4_K_M', parameterCount: 3085938688, trainedContext: 32768, ollamaModelPreserved: 'qwen2.5-coder:3b' },
  server: { host, flashAttention: 'on', kvCache: 'q8_0', gpuLayers: 'all', metalDevice: 'MTL0 Apple M5 Pro' },
  checkedAt: new Date().toISOString(),
  levels: results,
  validatedMaximum: passed.length ? Math.max(...passed) : 0,
  limitations: [
    'The Ollama model qwen2.5-coder:3b was not modified.',
    'YaRN is applied by llama.cpp runtime flags, not by GGUF metadata.',
    'A loaded context is not treated as retrieval success.',
    '192K uses factor 6 and 250K uses factor 7.63. Both are experimental.',
  ],
}
writeFileSync(reportPath, JSON.stringify(report, null, 2))
writeFileSync(`${outDir}/benchmark.json`, JSON.stringify(report, null, 2))
console.log(`wrote ${reportPath}`)
console.log(`validatedMaximum ${report.validatedMaximum}`)
