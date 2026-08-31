const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } = require('electron')
const { execFile, execFileSync, spawn } = require('child_process')
const pty = require('node-pty')
const os = require('os')
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')

let win
let watcher
let currentDirectory
let publishTimer
let publishRunning = false
let publishQueued = false
let watchGeneration = 0
let windowStateTimer
let aiSettings
let projects = []
let terminalProcess
let terminalSession = 0
let lastDirectoryDialogPath = ''
const pendingOperationLogs = []
const fileIndexCache = new Map()
const FILE_INDEX_DEBOUNCE_MS = 250

const PUBLISH_DEBOUNCE_MS = 200

function sendOperationLog(message) {
  const entry = { message: String(message), at: new Date().toISOString() }
  if (win && !win.isDestroyed()) win.webContents.send('operation-log', entry)
  else pendingOperationLogs.push(entry)
}

function serviceLog(level, ...parts) {
  const message = parts.map(part => part instanceof Error ? part.stack || part.message : typeof part === 'string' ? part : JSON.stringify(part)).join(' ')
  sendOperationLog(`[${level}] ${message}`)
}

function sendRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return
  try { win.webContents.send(channel, JSON.parse(JSON.stringify(payload))) } catch (error) { serviceLog('ERROR', `[IPC] Could not send ${channel}:`, error) }
}

function stopTerminal(sessionId = null) {
  if (sessionId !== null && sessionId !== terminalSession) return false
  if (terminalProcess) {
    try { terminalProcess.kill() } catch {}
    terminalProcess = null
  }
  terminalSession += 1
  return true
}

function windowStatePath() { return path.join(app.getPath('userData'), 'window-state.json') }
function settingsPath() { return path.join(app.getPath('userData'), 'settings.json') }
function projectsPath() { return path.join(app.getPath('userData'), 'projects.json') }
function dialogStatePath() { return path.join(app.getPath('userData'), 'dialog-state.json') }
function loadDialogState() { try { return JSON.parse(fs.readFileSync(dialogStatePath(), 'utf8')) } catch { return {} } }
function saveDialogState() { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(dialogStatePath(), JSON.stringify({ lastDirectoryDialogPath }, null, 2)) }
function loadProjects() { try { return JSON.parse(fs.readFileSync(projectsPath(), 'utf8')).map(project => typeof project === 'string' ? { path: project, icon: findProjectIcon(project), lastOpened: 0 } : { lastOpened: 0, ...project }).filter(project => typeof project?.path === 'string' && project.path && fs.existsSync(project.path)) } catch { return [] } }
function persistProjects() { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(projectsPath(), JSON.stringify(projects, null, 2)) }
const AI_REASONING_LEVELS = ['instant', 'low', 'medium', 'high']
function normalizeProviderConfig(provider, value = {}, legacy = {}) {
  const config = { ...legacy, ...(value && typeof value === 'object' ? value : {}) }
  const normalized = { model: String(config.model || ''), reasoning: AI_REASONING_LEVELS.includes(config.reasoning) ? config.reasoning : 'instant' }
  if (provider === 'ollama') normalized.endpoint = String(config.endpoint || 'http://localhost:11434').replace(/\/$/, '')
  return normalized
}
function normalizeAiSettings(settings = {}) {
  const provider = ['ollama', 'codex', 'claude'].includes(settings.provider) ? settings.provider : 'ollama'
  const savedProviders = settings.providers && typeof settings.providers === 'object' ? settings.providers : {}
  const legacy = { model: settings.model, reasoning: settings.reasoning, endpoint: settings.endpoint }
  return {
    aiEnabled: settings.aiEnabled === true,
    provider,
    providers: {
      ollama: normalizeProviderConfig('ollama', savedProviders.ollama, provider === 'ollama' ? legacy : {}),
      codex: normalizeProviderConfig('codex', savedProviders.codex, provider === 'codex' ? legacy : {}),
      claude: normalizeProviderConfig('claude', savedProviders.claude, provider === 'claude' ? legacy : {})
    },
    language: String(settings.language || 'English'),
  }
}
function providerConfig(provider = aiProvider()) {
  return aiSettings?.providers?.[provider] || normalizeProviderConfig(provider)
}
function loadSettings() {
  try { return normalizeAiSettings(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))) } catch { return normalizeAiSettings() }
}
function saveSettings(settings) {
  aiSettings = normalizeAiSettings(settings)
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(aiSettings, null, 2))
  return aiSettings
}

function shellCommand() {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'], label: 'PS' }
  const file = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return { file, args: ['-lc'], label: path.basename(file) }
}

function terminalShell() {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'] }
  const file = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return { file, args: ['-il'] }
}
function thinkingPayload() {
  const reasoning = providerConfig('ollama').reasoning
  return reasoning === 'instant' ? { think: false } : { think: reasoning }
}
async function requestChatWithThinking(endpoint, body) {
  try { return await requestJson(`${endpoint}/api/chat`, { method: 'POST' }, { ...body, ...thinkingPayload() }) } catch (error) {
    if (providerConfig('ollama').reasoning === 'instant') throw error
    return requestJson(`${endpoint}/api/chat`, { method: 'POST' }, { ...body, think: true })
  }
}
async function requestGenerateWithThinking(endpoint, body) {
  try { return await requestJson(`${endpoint}/api/generate`, { method: 'POST' }, { ...body, ...thinkingPayload() }) } catch (error) {
    if (providerConfig('ollama').reasoning === 'instant') throw error
    return requestJson(`${endpoint}/api/generate`, { method: 'POST' }, { ...body, think: true })
  }
}
const AI_PROVIDER_LABELS = { ollama: 'Ollama', codex: 'Codex', claude: 'Claude' }
const AI_CLI_TIMEOUT_MS = 180000

function aiProvider() { return ['ollama', 'codex', 'claude'].includes(aiSettings?.provider) ? aiSettings.provider : 'ollama' }
function assertAiConfigured() {
  if (!aiSettings?.aiEnabled) throw new Error('AI generation is disabled in Settings')
  if (aiProvider() === 'ollama' && (!providerConfig('ollama').endpoint || !providerConfig('ollama').model)) throw new Error('Configure the Ollama endpoint and model in Settings')
}
function knownWindowsCliCommand(name) {
  if (process.platform !== 'win32') return null
  const roots = []
  if (name === 'codex') {
    for (const root of [process.env.LOCALAPPDATA, process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : ''].filter(Boolean)) {
      const installRoot = path.join(root, 'OpenAI', 'Codex', 'bin')
      try {
        for (const entry of fs.readdirSync(installRoot, { withFileTypes: true })) {
          if (entry.isDirectory()) roots.push(path.join(installRoot, entry.name))
        }
      } catch {}
    }
  }
  const npmRoots = [process.env.APPDATA, process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : '', process.env.npm_config_prefix, process.env.NPM_CONFIG_PREFIX].filter(Boolean).map(root => path.basename(root).toLowerCase() === 'npm' ? root : path.join(root, 'npm'))
  roots.push(...npmRoots)
  const names = name === 'codex' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['claude.cmd', 'claude.exe', 'claude.bat']
  const candidates = roots.flatMap(root => names.map(candidate => path.join(root, candidate))).filter(candidate => fs.existsSync(candidate))
  return candidates.sort((left, right) => {
    try { return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs } catch { return 0 }
  })[0] || null
}
function resolveCliCommand(name) {
  if (process.platform !== 'win32') return name
  try {
    const outputs = execFileSync('where.exe', [name], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }).toString().split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    const nativeCommand = outputs.find(value => ['.exe', '.cmd', '.bat'].includes(path.extname(value).toLowerCase()))
    if (nativeCommand) return nativeCommand
    if (outputs[0]) return outputs[0]
  } catch {}
  return knownWindowsCliCommand(name) || name
}
function cliCommand(provider) { return resolveCliCommand(provider === 'codex' ? 'codex' : 'claude') }
function quotePowerShellArg(value) { return `'${String(value).replaceAll("'", "''")}'` }
function cliInvocation(provider, args) {
  const command = cliCommand(provider)
  if (process.platform === 'win32') return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', [`& ${quotePowerShellArg(command)}`, ...args.map(quotePowerShellArg)].join(' ')] }
  return { command, args, shell: true }
}
function cliEnvironment(provider) {
  const environment = { ...process.env }
  // Keep this flow OAuth-only: an API key in the parent environment must not
  // silently change the authentication mode selected in Pulse.
  if (provider === 'codex') delete environment.OPENAI_API_KEY
  if (provider === 'claude') {
    delete environment.ANTHROPIC_API_KEY
    delete environment.ANTHROPIC_AUTH_TOKEN
  }
  return environment
}
function runCli(command, args, { cwd = currentDirectory, input = '', timeout = AI_CLI_TIMEOUT_MS, provider } = {}) {
  return new Promise((resolve, reject) => {
    const invocation = cliInvocation(provider, args)
    const child = spawn(invocation.command, invocation.args, { cwd: cwd || undefined, env: cliEnvironment(provider), windowsHide: true, shell: invocation.shell, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch {}
      reject(new Error(`${AI_PROVIDER_LABELS[provider] || 'AI'} request timed out after ${Math.round(timeout / 1000)} seconds`))
    }, timeout)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error.code === 'ENOENT') return reject(new Error(`${AI_PROVIDER_LABELS[provider] || command} client not found. Install it and try again.`))
      reject(error)
    })
    child.once('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(stderr.trim() || `${AI_PROVIDER_LABELS[provider] || command} exited with code ${code}`))
      resolve(stdout)
    })
    child.stdin.end(input)
  })
}
function runCliStatus(command, args, provider) {
  return new Promise(resolve => {
    const invocation = cliInvocation(provider, args)
    execFile(invocation.command, invocation.args, { env: cliEnvironment(provider), windowsHide: true, shell: invocation.shell, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const output = String(stdout || stderr || error?.message || '').trim()
      resolve({ ok: !error, missing: error?.code === 'ENOENT' || error?.code === 9009 || /not recognized|not found/i.test(output), output })
    })
  })
}
function serializeAiMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(message => {
    const role = String(message?.role || 'user').toUpperCase()
    const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content || '')
    return `${role}:\n${content}`
  }).join('\n\n')
}
function extractCliText(raw) {
  const text = String(raw || '').trim()
  const candidates = []
  for (const line of text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    try {
      const value = JSON.parse(line)
      if (typeof value.result === 'string') candidates.push(value.result)
      if (typeof value.output === 'string') candidates.push(value.output)
      if (typeof value.item?.text === 'string') candidates.push(value.item.text)
      if (typeof value.item?.content === 'string') candidates.push(value.item.content)
      if (typeof value.message?.content === 'string') candidates.push(value.message.content)
      if (typeof value.content === 'string') candidates.push(value.content)
    } catch {}
  }
  return String(candidates.at(-1) || text).trim()
}
async function requestCliPrompt(provider, prompt) {
  const command = cliCommand(provider)
  const rawModel = String(providerConfig(provider).model || '').trim()
  const model = /^[A-Za-z0-9._:/-]+$/.test(rawModel) ? rawModel : ''
  if (provider === 'codex') {
    const args = ['exec', '--json', '--sandbox', 'read-only', ...(model ? ['--model', model] : []), '-']
    return extractCliText(await runCli(command, args, { provider, input: `${prompt}\n\nReturn only the final answer. Do not modify files, commit changes, or alter the repository.` }))
  }
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--tools', 'Read', ...(model ? ['--model', model] : [])]
  return extractCliText(await runCli(command, args, { provider, input: `Read the instruction supplied on stdin and return only the final answer.\n\n${prompt}\n\nReturn only the final answer. Do not modify files, commit changes, or alter the repository.` }))
}
async function requestAiChat(body) {
  const provider = aiProvider()
  if (provider === 'ollama') return requestChatWithThinking(providerConfig('ollama').endpoint, body)
  const prompt = serializeAiMessages(body.messages)
  sendRenderer('ai-prompt-log', { at: new Date().toISOString(), provider, mode: 'cli', prompt })
  return { message: { role: 'assistant', content: await requestCliPrompt(provider, prompt) } }
}
async function requestAiGenerate(body) {
  const provider = aiProvider()
  if (provider === 'ollama') return requestGenerateWithThinking(providerConfig('ollama').endpoint, body)
  const prompt = String(body.prompt || '')
  sendRenderer('ai-prompt-log', { at: new Date().toISOString(), provider, mode: 'cli', prompt })
  return { response: await requestCliPrompt(provider, prompt) }
}
async function getAiProviderStatus(provider = aiProvider()) {
  const selected = ['codex', 'claude'].includes(provider) ? provider : 'ollama'
  if (selected === 'ollama') return { provider: selected, label: AI_PROVIDER_LABELS[selected], installed: true, authenticated: false, configured: Boolean(providerConfig('ollama').endpoint && providerConfig('ollama').model) }
  const command = cliCommand(selected)
  const status = await runCliStatus(command, selected === 'codex' ? ['login', 'status'] : ['auth', 'status'], selected)
  return { provider: selected, label: AI_PROVIDER_LABELS[selected], command, installed: !status.missing, authenticated: status.ok, configured: status.ok }
}
async function loginAiProvider(provider = aiProvider()) {
  const selected = ['codex', 'claude'].includes(provider) ? provider : ''
  if (!selected) throw new Error('Select Codex or Claude to start OAuth login')
  const command = cliCommand(selected)
  const availability = await runCliStatus(command, ['--version'], selected)
  if (availability.missing) throw new Error(`${AI_PROVIDER_LABELS[selected]} client not found. Install it and try again.`)
  const args = selected === 'codex' ? ['login'] : ['auth', 'login']
  const invocation = cliInvocation(selected, args)
  const child = spawn(invocation.command, invocation.args, { cwd: currentDirectory || undefined, env: cliEnvironment(selected), detached: true, windowsHide: true, shell: invocation.shell, stdio: 'ignore' })
  child.once('error', error => serviceLog('ERROR', `[${AI_PROVIDER_LABELS[selected]}] login process failed`, error))
  child.unref()
  return { started: true, provider: selected }
}
const CLAUDE_MODEL_ALIASES = ['default', 'best', 'sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opus[1m]', 'opusplan']
function requestCodexModels() {
  return new Promise((resolve, reject) => {
    const invocation = cliInvocation('codex', ['app-server'])
    const child = spawn(invocation.command, invocation.args, { cwd: currentDirectory || undefined, env: cliEnvironment('codex'), windowsHide: true, shell: invocation.shell, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch {}
      reject(new Error('Codex model discovery timed out'))
    }, 30000)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch {}
      error ? reject(error) : resolve(value)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdout.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 1 && message.error) return finish(new Error(message.error.message || 'Codex initialization failed'))
        if (message.id === 2 && message.error) return finish(new Error(message.error.message || 'Codex model discovery failed'))
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
          child.stdin.write(`${JSON.stringify({ method: 'model/list', id: 2, params: { limit: 100, includeHidden: false } })}\n`)
        }
        if (message.id === 2) {
          const models = Array.isArray(message.result?.data) ? message.result.data : []
          const values = models.filter(model => typeof model?.model === 'string' && model.model).sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault))).map(model => model.model)
          finish(null, values)
        }
      }
    })
    child.once('error', error => finish(error.code === 'ENOENT' ? new Error('Codex client not found. Make sure the `codex` command is available in the app PATH.') : error))
    child.once('close', code => { if (!settled && code !== 0) finish(new Error(stderr.trim() || `Codex model discovery failed with exit code ${code}`)) })
    child.stdin.write(`${JSON.stringify({ method: 'initialize', id: 1, params: { clientInfo: { name: 'pulse_git_ai', title: 'Pulse Git AI', version: app.getVersion() } } })}\n`)
  })
}
function requestJson(urlString, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const client = url.protocol === 'https:' ? https : http
    serviceLog('INFO', '[Ollama] request', JSON.stringify({ url: urlString, method: options.method || 'GET', payload: body }, null, 2))
    if (/\/api\/(chat|generate)$/.test(url.pathname)) sendRenderer('ai-prompt-log', { at: new Date().toISOString(), url: urlString, payload: body })
    const request = client.request(url, { method: options.method || 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}) }, timeout: 120000 }, response => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { data += chunk })
      response.on('end', () => {
        serviceLog('INFO', '[Ollama] response', JSON.stringify({ url: urlString, status: response.statusCode, body: data }, null, 2))
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`HTTP ${response.statusCode}`))
        try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON response')) }
      })
    })
    request.on('error', error => { serviceLog('ERROR', '[Ollama] request error', error); reject(error) })
    request.on('timeout', () => { const error = new Error('Ollama request timed out after 120 seconds'); serviceLog('ERROR', '[Ollama] timeout', error); request.destroy(error) })
    if (body) request.write(JSON.stringify(body))
    request.end()
  })
}
function fetchGitHubJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'Pulse-Git-AI', Accept: 'application/vnd.github+json' }, timeout: 15000 }, response => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { data += chunk })
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`GitHub release check failed (HTTP ${response.statusCode})`))
        try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid GitHub release response')) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('GitHub release check timed out')))
    request.on('error', reject)
  })
}
function releaseVersion(value) { return String(value || '').replace(/^v/i, '').match(/^\d+(?:\.\d+){0,2}/)?.[0] || '' }
function compareReleaseVersions(left, right) { const a = releaseVersion(left).split('.').map(Number); const b = releaseVersion(right).split('.').map(Number); for (let index = 0; index < 3; index += 1) { const difference = (a[index] || 0) - (b[index] || 0); if (difference) return difference } return 0 }
async function fetchLatestRelease() {
  const releases = await fetchGitHubJson('https://api.github.com/repos/achilleterzo/Git-AI/releases?per_page=30')
  const candidates = (Array.isArray(releases) ? releases : [releases]).filter(release => {
    if (release.draft || !release.tag_name || !releaseVersion(release.tag_name)) return false
    const assets = Array.isArray(release.assets) ? release.assets : []
    return assets.some(asset => asset.state === 'uploaded' && Number(asset.size) > 0 && asset.browser_download_url && /\.(exe|msi|dmg|appimage|deb|zip)$/i.test(asset.name || ''))
  })
  const release = candidates.sort((left, right) => compareReleaseVersions(right.tag_name, left.tag_name))[0]
  if (!release) throw new Error('No published GitHub release found')
  const result = { version: releaseVersion(release.tag_name), tag: release.tag_name, url: release.html_url, name: release.name || release.tag_name, notes: release.body || '' }
  serviceLog('INFO', '[Update] latest release', result)
  return result
}
function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')) } catch { return null }
}
function saveWindowState() {
  if (!win || win.isDestroyed() || win.isMaximized()) return
  const bounds = win.getBounds()
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(windowStatePath(), JSON.stringify({ ...bounds, isMaximized: win.isMaximized() }))
}
function scheduleSaveWindowState() {
  clearTimeout(windowStateTimer)
  windowStateTimer = setTimeout(saveWindowState, 250)
}

function shellSnapshot(directory) {
  return new Promise((resolve, reject) => {
    // Index only files known to Git (tracked or non-ignored untracked files).
    // A recursive filesystem scan would repeatedly walk node_modules, build
    // output and other ignored directories that cannot affect Git status.
    const escapedDirectory = directory.replaceAll("'", "''")
    const script = `$gitRoot = (git -C '${escapedDirectory}' rev-parse --show-toplevel).Trim(); git -C '${escapedDirectory}' ls-files --cached --others --exclude-standard --full-name | ForEach-Object { $absolute = Join-Path $gitRoot $_; if (Test-Path -LiteralPath $absolute -PathType Leaf) { $item = Get-Item -LiteralPath $absolute -Force -ErrorAction SilentlyContinue; if ($item) { @{ path=$item.FullName; size=$item.Length; modified=$item.LastWriteTime.ToString('o') } } } } | ConvertTo-Json -Compress`
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const details = String(stderr || '').trim()
        const diagnostic = new Error(details ? `${error.message}: ${details}` : error.message)
        diagnostic.code = error.code
        diagnostic.killed = error.killed
        diagnostic.signal = error.signal
        serviceLog('ERROR', '[File scan]', { directory, code: error.code, killed: error.killed, signal: error.signal, stderr: details, command: script })
        return reject(diagnostic)
      }
      try {
        const parsed = stdout.trim() ? JSON.parse(stdout) : []
        resolve((Array.isArray(parsed) ? parsed : [parsed]).map((f) => ({ path: f.path, size: Number(f.size), modified: f.modified })))
      } catch (e) {
        serviceLog('ERROR', '[File scan] Invalid PowerShell JSON', { directory, error: e, stdout: stdout.slice(0, 4000) })
        reject(e)
      }
    })
  })
}
function getFileIndexState(directory) {
  let state = fileIndexCache.get(directory)
  if (!state) {
    state = { files: [], status: 'idle', error: null, requested: 0, running: false, queued: false, timer: null, updatedAt: null, gitSignature: null }
    fileIndexCache.set(directory, state)
  }
  return state
}
function sendFileIndexUpdate(directory, state) {
  if (directory !== currentDirectory) return
  // The renderer only needs the indexing state. Keeping the full file cache in
  // the main process avoids cloning thousands of entries across IPC.
  sendRenderer('file-index-update', { directory, status: state.status, error: state.error, updatedAt: state.updatedAt })
}
function scheduleFileIndexing(directory, generation = watchGeneration) {
  if (!directory || directory !== currentDirectory || generation !== watchGeneration) return
  const state = getFileIndexState(directory)
  state.requested += 1
  if (state.running) { state.queued = true; return }
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    state.timer = null
    runFileIndexing(directory, generation)
  }, FILE_INDEX_DEBOUNCE_MS)
}
async function runFileIndexing(directory, generation) {
  if (!directory || directory !== currentDirectory || generation !== watchGeneration) return
  const state = getFileIndexState(directory)
  if (state.running) { state.queued = true; return }
  state.running = true
  state.queued = false
  const request = state.requested
  state.status = 'indexing'
  state.error = null
  sendFileIndexUpdate(directory, state)
  try {
    state.files = await shellSnapshot(directory)
    state.status = 'ready'
    state.error = null
    state.updatedAt = new Date().toISOString()
    sendFileIndexUpdate(directory, state)
  } catch (error) {
    // An indexing failure must not affect Git status or the repository UI.
    state.status = 'error'
    state.error = String(error?.message || error)
    sendFileIndexUpdate(directory, state)
  } finally {
    state.running = false
    if (directory === currentDirectory && generation === watchGeneration && (state.queued || state.requested !== request)) {
      state.queued = false
      scheduleFileIndexing(directory, generation)
    }
  }
}
function gitChanges(directory) {
  return new Promise((resolve, reject) => execFile('git', ['-C', directory, 'status', '--porcelain=v1', '--untracked-files=all'], { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(stderr.trim() || error.message))
    resolve(stdout.split(/\r?\n/).filter(Boolean).map(line => {
      const code = line.slice(0, 2)
      let file = line.slice(3)
      // Porcelain v1 renders renames as: "old path" -> "new path".
      // The UI and subsequent git commands must receive only the destination.
      if (code.includes('R') || code.includes('C')) {
        const arrow = file.lastIndexOf(' -> ')
        if (arrow >= 0) file = file.slice(arrow + 4)
      }
      file = file.replace(/^"|"$/g, '')
      return { file, code, status: code === '??' || code.includes('A') ? 'Added' : code.includes('D') ? 'Deleted' : 'Modified' }
    }))
  }))
}
function ensureGitRepository(directory) {
  return new Promise((resolve, reject) => execFile('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error('The selected directory is not a Git repository'))
    resolve(stdout.trim())
  }))
}
function isDirectoryEmpty(directory) {
  return fs.readdirSync(directory).length === 0
}
function runGit(directory, args, timeout = 120000) {
  return new Promise((resolve, reject) => execFile('git', ['-C', directory, ...args], { windowsHide: true, timeout, maxBuffer: 128 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || stdout.trim() || error.message)) : resolve(stdout.trim())) )
}
function runGitWithPathspec(directory, args, paths, timeout = 120000) {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-git-pathspec-'))
  const pathspecFile = path.join(tempDirectory, 'paths')
  fs.writeFileSync(pathspecFile, Buffer.from(paths.map(value => String(value)).join('\0'), 'utf8'))
  return new Promise((resolve, reject) => execFile('git', ['-C', directory, ...args, `--pathspec-from-file=${pathspecFile}`, '--pathspec-file-nul'], { windowsHide: true, timeout, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || stdout.trim() || error.message)) : resolve(stdout.trim()))).finally(() => {
    try { fs.rmSync(tempDirectory, { recursive: true, force: true }) } catch {}
  })
}
function parseNumstat(output) {
  return String(output || '').split('\0').map(record => {
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) return null
    return { added: record.slice(0, firstTab), deleted: record.slice(firstTab + 1, secondTab), file: record.slice(secondTab + 1) }
  }).filter(record => record?.file)
}
async function gitDiffForFile(directory, file, hasCommits = null) {
  const repositoryHasCommits = hasCommits === null ? await gitHasCommits(directory) : hasCommits
  if (repositoryHasCommits) return runGit(directory, ['diff', 'HEAD', '--unified=2', '--', file], 30000).catch(() => 'No diff available for this file.')
  const [cached, workingTree] = await Promise.all([
    runGit(directory, ['diff', '--cached', '--unified=2', '--', file], 30000).catch(() => ''),
    runGit(directory, ['diff', '--unified=2', '--', file], 30000).catch(() => '')
  ])
  return [cached, workingTree].filter(Boolean).join('\n') || 'No diff available for this file.'
}
function runGitWithEnv(directory, args, env, timeout = 120000) {
  return new Promise((resolve, reject) => execFile('git', ['-C', directory, ...args], { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || stdout.trim() || error.message)) : resolve(stdout.trim())))
}
const GIT_PROGRESS_PATTERN = /^(?:remote:\s*)?([A-Za-z][A-Za-z ]*[A-Za-z]):\s+(\d{1,3})%/
const GIT_STREAM_IDLE_MS = 120000

// Streams a git command instead of buffering it, so long network operations can report
// real progress to the renderer. The timeout is on idleness, not on total duration: a
// large clone stays alive as long as git keeps talking.
function runGitStreaming(args, { cwd, idleTimeout = GIT_STREAM_IDLE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    const pending = { out: '', err: '' }
    let output = ''
    let failure = ''
    let settled = false
    let idleTimer = null
    let lastProgress = ''
    const settle = (action, value) => { if (settled) return; settled = true; if (idleTimer) clearTimeout(idleTimer); action(value) }
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        child.kill()
        settle(reject, new Error(`No output from git for ${Math.round(idleTimeout / 1000)}s; the operation was aborted`))
      }, idleTimeout)
    }
    const handleLine = (raw, isError) => {
      const line = raw.trim()
      if (!line) return
      if (isError) failure += `${line}\n`
      else output += `${line}\n`
      const match = line.match(GIT_PROGRESS_PATTERN)
      if (match) {
        const tick = `${match[1].trim()}:${match[2]}`
        if (tick !== lastProgress) { lastProgress = tick; sendRenderer('operation-progress', { phase: match[1].trim(), percent: Number(match[2]) }) }
        if (!/done\.$/.test(line)) return
      }
      sendOperationLog(line)
    }
    const consume = (key, chunk, isError) => {
      armIdle()
      const parts = (pending[key] + chunk).split(/\r\n|\r|\n/)
      pending[key] = parts.pop()
      parts.forEach(line => handleLine(line, isError))
    }
    armIdle()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => consume('out', chunk, false))
    child.stderr.on('data', chunk => consume('err', chunk, true))
    child.on('error', error => settle(reject, error))
    child.on('close', code => {
      if (pending.out) handleLine(pending.out, false)
      if (pending.err) handleLine(pending.err, true)
      if (code === 0) settle(resolve, output.trim())
      else settle(reject, new Error(failure.trim() || output.trim() || `git ${args.find(arg => !arg.startsWith('-') && arg !== '-C') || ''} exited with code ${code}`))
    })
  })
}

function gitAheadBehind(directory) {
  return new Promise(resolve => execFile('git', ['-C', directory, 'rev-list', '--left-right', '--count', '@{u}...HEAD'], { windowsHide: true, timeout: 10000 }, (error, stdout) => {
    if (!error) {
      const [incoming, outgoing] = stdout.trim().split(/\s+/).map(value => Number.parseInt(value, 10) || 0)
      return resolve({ incoming, outgoing })
    }
    execFile('git', ['-C', directory, 'rev-list', '--count', 'HEAD'], { windowsHide: true, timeout: 10000 }, (headError, headStdout) => resolve({ incoming: 0, outgoing: headError ? 0 : Number.parseInt(headStdout.trim(), 10) || 0 }))
  }))
}
function gitCurrentBranch(directory) {
  return new Promise(resolve => execFile('git', ['-C', directory, 'branch', '--show-current'], { windowsHide: true, timeout: 10000 }, (error, stdout) => {
    const branch = !error ? stdout.trim() : ''
    if (branch) return resolve(branch)
    execFile('git', ['-C', directory, 'rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true, timeout: 10000 }, (fallbackError, fallbackStdout) => {
      const fallbackBranch = !fallbackError ? fallbackStdout.trim() : ''
      resolve(fallbackBranch && fallbackBranch !== 'HEAD' ? fallbackBranch : '')
    })
  }))
}
function gitHasCommits(directory) {
  return new Promise(resolve => execFile('git', ['-C', directory, 'rev-parse', '--verify', 'HEAD'], { windowsHide: true, timeout: 10000 }, error => resolve(!error)))
}
// `git lfs track` prints a tracked section followed by an excluded one; only the first
// holds patterns, and neither section header may be mistaken for one.
function parseLfsPatterns(output) {
  const patterns = []
  let tracked = false
  for (const line of String(output).split(/\r?\n/)) {
    if (/^Listing /.test(line)) { tracked = line.startsWith('Listing tracked patterns'); continue }
    const pattern = line.trim().split(/\s+/)[0]
    if (tracked && pattern) patterns.push(pattern)
  }
  return patterns
}
// `git lfs install` writes filter.lfs.* to the user's global config, and the Windows
// installer writes it system-wide, so a --local lookup really asks "was LFS turned on
// from inside this app?" — it answers false for every repository set up the normal way.
// A repository counts as LFS when it opted in locally or when it declares any pattern.
function gitLfsAvailable(directory) {
  const optedInLocally = new Promise(resolve => execFile('git', ['-C', directory, 'config', '--local', '--get-regexp', '^filter\\.lfs\\.'], { windowsHide: true, timeout: 10000 }, error => resolve(!error)))
  const tracked = runGit(directory, ['lfs', 'track'], 10000).then(parseLfsPatterns).catch(() => [])
  return Promise.all([optedInLocally, tracked]).then(([enabled, patterns]) => enabled || patterns.length > 0)
}
function findProjectIcon(directory) {
  try {
    const candidates = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && /\.(png|jpe?g|webp|ico)$/i.test(entry.name))
    candidates.sort((a, b) => { const score = name => /icon|logo|favicon/i.test(name) ? 0 : 1; return score(a.name) - score(b.name) || a.name.localeCompare(b.name) })
    const icon = candidates[0]
    if (!icon) return null
    const absolute = path.join(directory, icon.name)
    const data = fs.readFileSync(absolute)
    if (data.length > 2 * 1024 * 1024) return null
    const mime = icon.name.toLowerCase().endsWith('.ico') ? 'image/x-icon' : icon.name.toLowerCase().endsWith('.webp') ? 'image/webp' : icon.name.toLowerCase().endsWith('.jpg') || icon.name.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
    return `data:${mime};base64,${data.toString('base64')}`
  } catch { return null }
}
function readIconFile(filePath) {
  try {
    const data = fs.readFileSync(filePath)
    if (data.length > 2 * 1024 * 1024) return null
    const extension = path.extname(filePath).toLowerCase()
    const mime = extension === '.ico' ? 'image/x-icon' : extension === '.webp' ? 'image/webp' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.svg' ? 'image/svg+xml' : 'image/png'
    return `data:${mime};base64,${data.toString('base64')}`
  } catch { return null }
}

async function publish(reason = 'refresh', generation = watchGeneration) {
  if (!currentDirectory || generation !== watchGeneration) return
  if (publishRunning) { publishQueued = true; return }

  publishRunning = true
  const directory = currentDirectory
  try {
    // Git state must not wait for the best-effort filesystem index.
    const results = await Promise.allSettled([gitChanges(directory), gitAheadBehind(directory), gitCurrentBranch(directory), gitLfsAvailable(directory), gitHasCommits(directory)])
    const changes = results[0].status === 'fulfilled' ? results[0].value : []
    const indexState = getFileIndexState(directory)
    const gitSignature = changes.map(change => `${change.code}\0${change.file}`).join('\0')
    const gitStateChanged = indexState.gitSignature !== gitSignature
    indexState.gitSignature = gitSignature
    if (gitStateChanged) scheduleFileIndexing(directory, generation)
    if (!fs.existsSync(directory)) {
      if (watcher) watcher.close()
      if (publishTimer) { clearTimeout(publishTimer); publishTimer = null }
      watcher = null
      currentDirectory = null
      watchGeneration += 1
      publishQueued = false
      sendRenderer('directory-update', { directory: '', removedDirectory: directory, projectIcon: null, files: [], changes: [], incomingCommits: 0, outgoingCommits: 0, branch: '', gitLfs: false, hasCommits: false, gitOk: false, reason: 'directory-removed', error: null, at: new Date().toISOString() })
      return null
    }
    const gitError = results[0].status === 'rejected' ? `Git: ${results[0].reason.message}` : null
    if (directory === currentDirectory && generation === watchGeneration) {
      const aheadBehind = results[1].status === 'fulfilled' ? results[1].value : { incoming: 0, outgoing: 0 }
      const branch = results[2].status === 'fulfilled' ? results[2].value : ''
      const gitLfs = results[3].status === 'fulfilled' ? results[3].value : false
      const hasCommits = results[4].status === 'fulfilled' ? results[4].value : false
      const project = projects.find(item => item.path === directory)
      if (project && project.gitLfs !== gitLfs) { project.gitLfs = gitLfs; persistProjects() }
      const update = { directory, projectIcon: findProjectIcon(directory), changes, incomingCommits: aheadBehind.incoming, outgoingCommits: aheadBehind.outgoing, branch, gitLfs, hasCommits, gitOk: results[0].status === 'fulfilled', indexing: getFileIndexState(directory).status, reason, error: gitError, at: new Date().toISOString() }
      sendRenderer('directory-update', update)
      return update
    }
  } catch (error) {
    if (directory === currentDirectory && generation === watchGeneration) sendRenderer('directory-update', { error: error.message })
  } finally {
    publishRunning = false
    if (publishQueued) {
      publishQueued = false
      schedulePublish('coalesced-refresh')
    }
  }
}

function schedulePublish(reason = 'refresh') {
  if (!currentDirectory) return
  if (publishTimer) clearTimeout(publishTimer)
  const generation = watchGeneration
  publishTimer = setTimeout(() => {
    publishTimer = null
    publish(reason, generation)
  }, PUBLISH_DEBOUNCE_MS)
}

function createWindow() {
  const saved = loadWindowState()
  const display = screen.getAllDisplays().find(item => saved && item.workArea.x <= saved.x + saved.width / 2 && item.workArea.x + item.workArea.width >= saved.x + saved.width / 2 && item.workArea.y <= saved.y + saved.height / 2 && item.workArea.y + item.workArea.height >= saved.y + saved.height / 2)
  const defaults = { width: 1180, height: 760, x: 0, y: 0 }
  const bounds = saved && display ? { x: saved.x, y: saved.y, width: Math.max(900, saved.width), height: Math.max(620, saved.height) } : defaults
  win = new BrowserWindow({ ...bounds, minWidth: 900, minHeight: 620, icon: path.join(__dirname, '../assets/pulse-git-ai.png'), backgroundColor: '#17191c', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } })
  if (saved?.isMaximized) win.maximize()
  win.on('resize', scheduleSaveWindowState)
  win.on('move', scheduleSaveWindowState)
  win.on('close', saveWindowState)
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL)
  else win.loadFile(path.join(__dirname, '../dist/index.html'))
  win.webContents.on('did-fail-load', (_, code, description) => serviceLog('ERROR', `Renderer load failed (${code}): ${description}`))
  for (const entry of pendingOperationLogs.splice(0)) win.webContents.send('operation-log', entry)
}
async function startWatching(directory) {
  // Invalidate the previous watcher before validating the new target. Its
  // in-flight publish must not be able to restore the old project in the UI.
  if (watcher) { watcher.close(); watcher = null }
  if (publishTimer) { clearTimeout(publishTimer); publishTimer = null }
  watchGeneration += 1
  const generation = watchGeneration
  publishQueued = false
  currentDirectory = ''
  try {
    await ensureGitRepository(directory)
  } catch (error) {
    // A valid directory without a .git folder is still a usable project:
    // the renderer can offer either local initialization or a remote checkout.
    if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
      const repositoryError = new Error('The selected directory is not a Git repository')
      repositoryError.code = 'NOT_A_GIT_REPOSITORY'
      throw repositoryError
    }
    throw error
  }
  if (generation !== watchGeneration) return { ok: false, code: 'WATCH_SUPERSEDED' }
  currentDirectory = directory
  watcher = fs.watch(directory, { recursive: true }, (_, filename) => {
    if (generation !== watchGeneration) return
    const changedPath = filename ? String(filename).replaceAll('\\', '/') : ''
    schedulePublish(changedPath || 'change')
  })
  watcher.on('error', error => {
    if (error?.code === 'ENOENT' || !fs.existsSync(directory)) schedulePublish('directory-removed')
  })
  sendFileIndexUpdate(directory, getFileIndexState(directory))
  await publish('started', generation)
}
function openDirectory() { dialog.showOpenDialog(win, { properties: ['openDirectory'] }).then(result => { if (result.filePaths[0]) startWatching(result.filePaths[0]) }) }
function buildMenu() { Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'File', submenu: [{ label: 'AI .gitignore Assistant…', click: () => win.webContents.send('open-project-assistant') }, { label: 'Settings…', click: () => win.webContents.send('open-settings') }, { label: 'About Pulse Git AI', click: () => win.webContents.send('open-about') }, { type: 'separator' }, { role: 'quit' }] }])) }

ipcMain.handle('choose-directory', async (_, initialPath) => { const fallback = projects.slice().sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))[0]?.path; const defaultPath = [initialPath, lastDirectoryDialogPath, currentDirectory, fallback].find(value => value && fs.existsSync(value)); const result = await dialog.showOpenDialog(win, { defaultPath, properties: ['openDirectory'] }); const selected = result.filePaths[0] || null; if (selected) { lastDirectoryDialogPath = selected; saveDialogState() } return selected })
ipcMain.handle('choose-project-icon', async (_, projectDirectory) => { const defaultPath = projectDirectory && fs.existsSync(projectDirectory) ? projectDirectory : undefined; const result = await dialog.showOpenDialog(win, { defaultPath, properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'ico', 'svg'] }] }); return result.filePaths[0] ? readIconFile(result.filePaths[0]) : null })
ipcMain.handle('get-project-icon', (_, directory) => directory ? findProjectIcon(directory) : null)
ipcMain.handle('start-watching', async (_, directory) => {
  try {
    return await startWatching(directory) || { ok: true }
  } catch (error) {
    // Expected setup state must cross IPC as data; Electron does not preserve
    // custom Error properties such as `code` when rejecting invoke().
    if (error?.code === 'NOT_A_GIT_REPOSITORY' || String(error?.message || '').includes('not a Git repository')) {
      return { ok: false, code: 'NOT_A_GIT_REPOSITORY', message: 'The selected directory is not a Git repository' }
    }
    throw error
  }
})
ipcMain.handle('initialize-repository', async (_, directory) => { sendOperationLog(`Initializing Git repository in ${directory}`); await runGit(directory, ['init'], 30000); sendOperationLog('Git repository initialized'); await startWatching(directory); sendOperationLog('Watcher started'); return { ok: true } })
ipcMain.handle('checkout-repository', async (_, { directory, remote }) => {
  if (!directory || !String(remote || '').trim()) throw new Error('Enter a repository URL')
  const remoteUrl = String(remote).trim()
  sendOperationLog(`Checking out ${remoteUrl} into ${directory}`)
  const isRepository = await ensureGitRepository(directory).then(() => true).catch(() => false)
  try {
    if (isRepository) {
    sendOperationLog('The destination is already a Git repository; reconnecting the remote')
    const existingRemote = await runGit(directory, ['remote', 'get-url', 'origin'], 30000).catch(() => '')
    if (!existingRemote) await runGit(directory, ['remote', 'add', 'origin', remoteUrl], 30000)
    await runGitStreaming(['-C', directory, 'fetch', '--progress', 'origin'])
    await runGit(directory, ['remote', 'set-head', 'origin', '-a'], 30000).catch(() => '')
    const remoteHead = await runGit(directory, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 30000).catch(() => '')
    if (remoteHead.startsWith('origin/')) await runGit(directory, ['checkout', '-B', remoteHead.slice('origin/'.length), remoteHead], 30000)
    } else if (isDirectoryEmpty(directory)) {
      sendOperationLog('Destination is empty; running git clone')
      await runGitStreaming(['clone', '--progress', remoteUrl, directory])
    } else {
      sendOperationLog('Destination is not a repository; initializing it for remote checkout')
      await runGit(directory, ['init'], 30000)
      await runGit(directory, ['remote', 'add', 'origin', remoteUrl], 30000)
      await runGitStreaming(['-C', directory, 'fetch', '--progress', 'origin'])
      await runGit(directory, ['remote', 'set-head', 'origin', '-a'], 30000).catch(() => '')
      const remoteHead = await runGit(directory, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 30000).catch(() => '')
      if (!remoteHead.startsWith('origin/')) throw new Error('The remote repository has no default branch')
      await runGit(directory, ['checkout', '-B', remoteHead.slice('origin/'.length), remoteHead], 30000)
    }
  } catch (checkoutError) {
    throw checkoutError
  }
  await startWatching(directory)
  sendOperationLog('Checkout completed and watcher started')
  return { ok: true }
})
ipcMain.handle('git-changes', () => currentDirectory ? gitChanges(currentDirectory) : [])
ipcMain.handle('get-settings', () => aiSettings)
ipcMain.handle('get-ai-status', async (_, provider) => getAiProviderStatus(provider || aiProvider()))
ipcMain.handle('login-ai-provider', async (_, provider) => loginAiProvider(provider || aiProvider()))
ipcMain.handle('get-app-version', () => app.getVersion())
ipcMain.handle('open-devtools', () => { if (!app.isPackaged && win && !win.isDestroyed()) win.webContents.openDevTools({ mode: 'detach' }); return !app.isPackaged })
ipcMain.handle('get-latest-release', async () => { try { return await fetchLatestRelease() } catch (error) { serviceLog('ERROR', '[Update] release check failed', error); throw error } })
ipcMain.handle('open-release', (_, url) => { if (typeof url === 'string' && /^https:\/\/github\.com\//.test(url)) return shell.openExternal(url); return false })
ipcMain.handle('save-settings', (_, settings) => saveSettings(settings))
ipcMain.handle('fetch-models', async (_, request = {}) => {
  const provider = typeof request === 'string' ? 'ollama' : (request.provider || aiProvider())
  if (provider === 'claude') return CLAUDE_MODEL_ALIASES
  if (provider === 'codex') return requestCodexModels()
  const endpoint = typeof request === 'string' ? request : request.endpoint
  if (!endpoint) throw new Error('Configure the Ollama endpoint in Settings')
  const data = await requestJson(`${String(endpoint).replace(/\/$/, '')}/api/tags`)
  return (data.models || []).map(model => model.name).filter(Boolean)
})
ipcMain.handle('get-project-assistant-context', async () => {
  if (!currentDirectory) throw new Error('No directory selected')
  const files = (await runGit(currentDirectory, ['ls-files', '--cached', '--others', '--exclude-standard'])).split(/\r?\n/).filter(Boolean).slice(0, 1200)
  const entries = files.map(file => { try { const stat = fs.statSync(path.join(currentDirectory, file)); return { path: file, size: stat.size, type: stat.isDirectory() ? 'directory' : 'file' } } catch { return { path: file, type: 'file' } } })
  return { directory: path.basename(currentDirectory), files: entries }
})
ipcMain.handle('generate-project-plan', async (_, instruction) => {
  if (!currentDirectory) throw new Error('No directory selected')
  assertAiConfigured()
  const root = path.basename(currentDirectory)
  const prompt = `You are a .gitignore assistant. The project root is named "${root}". Investigate the project yourself using the available tools. Infer the project type only from evidence in the project. Your ONLY task is to propose file and directory patterns that should be added to the root .gitignore. Do not propose README files, source changes, folder moves, deletions, or any file other than .gitignore. Return ONLY valid JSON with this shape: {"summary":"...","entries":[{"pattern":"pattern","reason":"why it should be ignored"}]}. Do not include patterns that would hide source files or user-authored project files.\n\nUSER INSTRUCTIONS:\n${String(instruction || '').trim()}`
  const tools = [
    { type: 'function', function: { name: 'list_project', description: 'List relevant files and directories in the current project root.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'read_file', description: 'Read a text file from the current project when needed for the requested change.', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } } }
  ]
  const messages = [{ role: 'user', content: prompt }]
  let raw = ''
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await requestAiChat({ model: providerConfig().model, messages, tools, stream: false })
    const assistant = result.message || {}
    messages.push(assistant)
    const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : []
    if (!calls.length) { raw = String(assistant.content || ''); break }
    for (const call of calls) {
      const name = call?.function?.name
      const args = typeof call?.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : (call?.function?.arguments || {})
      let content = 'Unknown tool'
      if (name === 'list_project') content = (await runGit(currentDirectory, ['ls-files', '--cached', '--others', '--exclude-standard'])).split(/\r?\n/).filter(Boolean).join('\n')
      if (name === 'read_file') {
        const relative = String(args.path || '')
        if (!relative || relative.includes('..') || path.isAbsolute(relative)) throw new Error('AI requested an unsafe project path')
        try { content = fs.readFileSync(path.resolve(currentDirectory, relative), 'utf8').slice(0, 24000) } catch { content = 'File unavailable or binary.' }
      }
      messages.push({ role: 'tool', tool_name: name, content: String(content).slice(0, 30000) })
    }
  }
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const jsonStart = fenced.indexOf('{')
  const jsonEnd = fenced.lastIndexOf('}')
  const cleaned = jsonStart >= 0 && jsonEnd > jsonStart ? fenced.slice(jsonStart, jsonEnd + 1) : fenced
  let plan
  try { plan = JSON.parse(cleaned) } catch { throw new Error('AI returned an invalid project plan') }
  if (!plan || !Array.isArray(plan.entries)) throw new Error('AI returned an invalid ignore proposal')
  const ignorePath = path.join(currentDirectory, '.gitignore')
  const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : ''
  const entries = plan.entries.filter(entry => typeof entry?.pattern === 'string' && entry.pattern.trim() && !entry.pattern.includes('..') && !entry.pattern.includes('\0'))
  const additions = entries.map(entry => `# ${String(entry.reason || 'AI suggestion').replace(/[\r\n#]/g, ' ').trim()}\n${entry.pattern.trim()}`).join('\n')
  plan.changes = additions ? [{ action: 'update', path: '.gitignore', content: `${existing.trimEnd()}${existing.trimEnd() ? '\n\n' : ''}${additions}\n`, reason: entries.map(entry => `${entry.pattern.trim()} — ${String(entry.reason || 'AI suggestion').replace(/[\r\n#]/g, ' ').trim()}`).join(' | ') }] : []
  delete plan.entries
  return plan
})
ipcMain.handle('apply-project-plan', async (_, changes) => {
  if (!currentDirectory || !Array.isArray(changes)) throw new Error('Invalid project plan')
  for (const change of changes) {
    if (!['create', 'update'].includes(change.action) || typeof change.path !== 'string' || change.path.includes('..') || path.isAbsolute(change.path) || typeof change.content !== 'string') throw new Error('Invalid project plan path')
    const target = path.resolve(currentDirectory, change.path)
    if (!target.startsWith(path.resolve(currentDirectory) + path.sep)) throw new Error('Invalid project plan path')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, change.content, 'utf8')
    sendOperationLog(`AI project assistant ${change.action}d ${change.path}`)
  }
  await publish('ai-project-plan')
  return { applied: changes.length }
})
ipcMain.handle('add-gitignore-entry', async (_, { kind, value } = {}) => {
  if (!currentDirectory) throw new Error('No Git repository selected')
  const entryKind = String(kind || '')
  const rawValue = String(value || '').trim()
  let pattern
  if (entryKind === 'extension') {
    if (!/^\.[^/\\\s]+$/.test(rawValue)) throw new Error('Invalid file extension')
    pattern = `*${rawValue}`
  } else {
    const relative = rawValue.replaceAll('\\', '/').replace(/^\/+/, '')
    if (!relative || relative === '.' || relative.split('/').some(part => !part || part === '..') || path.isAbsolute(rawValue)) throw new Error('Invalid ignore path')
    pattern = `/${relative}${entryKind === 'folder' ? '/' : ''}`
  }
  const ignorePath = path.join(currentDirectory, '.gitignore')
  const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : ''
  const lines = existing.split(/\r?\n/)
  if (!lines.some(line => line.trim() === pattern)) {
    const next = `${existing.trimEnd()}${existing.trimEnd() ? '\n' : ''}${pattern}\n`
    fs.writeFileSync(ignorePath, next, 'utf8')
  }
  sendOperationLog(`Added ${pattern} to .gitignore`)
  await publish('gitignore-update')
  return { pattern, added: !lines.some(line => line.trim() === pattern) }
})
ipcMain.handle('add-gitignore-selection', async (_, { entries } = {}) => {
  if (!currentDirectory) throw new Error('No Git repository selected')
  const patterns = (Array.isArray(entries) ? entries : []).map(entry => {
    const kind = String(entry?.kind || '')
    const rawValue = String(entry?.value || '').trim()
    const relative = rawValue.replaceAll('\\', '/').replace(/^\/+/, '')
    if (!['file', 'folder'].includes(kind) || !relative || relative === '.' || path.isAbsolute(rawValue) || relative.split('/').some(part => !part || part === '..')) throw new Error('Invalid ignore selection')
    return `/${relative}${kind === 'folder' ? '/' : ''}`
  }).filter((pattern, index, all) => all.indexOf(pattern) === index)
  if (!patterns.length) throw new Error('No files or folders selected')
  const ignorePath = path.join(currentDirectory, '.gitignore')
  const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : ''
  const lines = existing.split(/\r?\n/)
  const additions = patterns.filter(pattern => !lines.some(line => line.trim() === pattern))
  if (additions.length) fs.writeFileSync(ignorePath, `${existing.trimEnd()}${existing.trimEnd() ? '\n' : ''}${additions.join('\n')}\n`, 'utf8')
  sendOperationLog(`Added ${additions.length} selected ignore rule${additions.length === 1 ? '' : 's'} to .gitignore`)
  await publish('gitignore-update')
  return { patterns, added: additions.length }
})
ipcMain.handle('generate-commit-message', async (_, { files, operation = 'commit' } = {}) => {
  if (!currentDirectory) throw new Error('No directory selected')
  assertAiConfigured()
  const selected = Array.isArray(files) ? files.filter(file => typeof file === 'string' && file && !file.includes('..')) : []
  if (!selected.length) throw new Error('Select at least one file')
  // Do not append every selected path to the command line: a full directory
  // selection can exceed Windows' process argument limit. Read repository
  // state once and filter it in memory instead.
  const normalizedSelected = selected.map(file => file.replaceAll('\\', '/'))
  const isSelectedPath = file => {
    const normalizedFile = file.replaceAll('\\', '/')
    return normalizedSelected.some(selection => normalizedFile === selection || normalizedFile.startsWith(`${selection}/`))
  }
  const workingTreeChanges = await gitChanges(currentDirectory)
  const selectedChanges = workingTreeChanges.filter(change => isSelectedPath(change.file))
  const untracked = selectedChanges.filter(change => change.code === '??').map(change => change.file)
  const fileList = selectedChanges.map(change => `${change.code} ${change.file}`).join('\n')
  const hasCommits = await gitHasCommits(currentDirectory)
  const diffOutputs = hasCommits
    ? [await runGit(currentDirectory, ['diff', 'HEAD', '--numstat', '-z', '--no-renames'], 30000)]
    : await Promise.all([
      runGit(currentDirectory, ['diff', '--cached', '--numstat', '-z', '--no-renames'], 30000),
      runGit(currentDirectory, ['diff', '--numstat', '-z', '--no-renames'], 30000)
    ])
  const diffRecords = diffOutputs.flatMap(parseNumstat)
  const diffStat = diffRecords.filter(record => isSelectedPath(record.file)).map(record => `${record.added}\t${record.deleted}\t${record.file}`).join('\n')
  if (!fileList.trim() && !untracked.length) throw new Error('No diff available for the selected files')
  const selectedSet = new Set(normalizedSelected)
  const prompt = operation === 'planned-commits' ? `TASK: Plan several small, coherent Git commits for the selected changes.
MANDATORY LANGUAGE: ${aiSettings.language}. Every message MUST be written entirely in ${aiSettings.language}.
OUTPUT: Return ONLY valid JSON, exactly {"commits":[{"files":["path"],"message":"type(scope): description"}]}.
Every selected file must appear exactly once, and every commit must contain at least one file. Use Conventional Commits messages. Do not include the plan, reasoning, markdown or extra fields in messages.
SELECTED FILES AND STATUS:
${fileList.slice(0, 8000)}

DIFF STAT:
${diffStat.slice(0, 4000)}` : operation === 'stash' ? `TASK: Write a short label for temporary, unfinished work that is being saved in a Git stash.
MANDATORY LANGUAGE: ${aiSettings.language}. The description MUST be written entirely in ${aiSettings.language}.
FORMAT: Natural language, optionally beginning with the lowercase prefix "wip:".
OUTPUT RULES: Return one line only. This is a stash label, not a commit message: do not use Conventional Commits syntax, type/scope prefixes, uppercase labels, release language, imperative commit wording, markdown, quotes or explanation. Emphasize that the work is temporary or unfinished and summarize the complete selected change set.
Use get_file_diff for the relevant selected files and read_file only when needed. Inspect enough files to describe the whole work in progress.

SELECTED FILES AND STATUS:
${fileList.slice(0, 8000)}

DIFF STAT:
${diffStat.slice(0, 4000)}` : `TASK: Write exactly one Conventional Commits message.
MANDATORY LANGUAGE: ${aiSettings.language}. The description MUST be written entirely in ${aiSettings.language}.
FORMAT: <type>(<scope>): <description>
ALLOWED TYPES: feat, fix, refactor, chore, docs, test
OUTPUT RULES: Return one line only. No markdown, quotes, translation, explanation, prefix or suffix.
Use get_file_diff for the relevant selected files and read_file only when needed. Cover the overall change, not just the last file. Return the message only after inspecting the relevant diffs.

SELECTED FILES AND STATUS:
${fileList.slice(0, 8000)}

DIFF STAT:
${diffStat.slice(0, 4000)}`
  const tools = [
    { type: 'function', function: { name: 'get_file_diff', description: 'Get the diff for one selected repository-relative file.', parameters: { type: 'object', required: ['file'], properties: { file: { type: 'string' } } } } },
    { type: 'function', function: { name: 'read_file', description: 'Read one selected repository-relative file only when its diff needs context.', parameters: { type: 'object', required: ['file'], properties: { file: { type: 'string' } } } } }
  ]
  const messages = [{ role: 'user', content: prompt }]
  let finalContent = ''
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const result = await requestAiChat({ model: providerConfig().model, messages, tools, stream: false })
    const assistant = result.message || {}
    messages.push(assistant)
    const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : []
    if (!calls.length) { finalContent = String(assistant.content || '').trim(); break }
    for (const call of calls) {
      const name = call?.function?.name
      const rawArgs = call?.function?.arguments
      const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {})
      const file = String(args.file || '')
      if (!selectedSet.has(file.replaceAll('\\', '/')) || file.includes('..') || path.isAbsolute(file)) throw new Error('AI requested a file outside the selected changes')
      let content = 'Unknown tool'
      if (name === 'get_file_diff') {
        content = untracked.includes(file)
          ? (() => { try { return `New file ${file}:\n${fs.readFileSync(path.resolve(currentDirectory, file), 'utf8').slice(0, 16000)}` } catch { return 'New binary or unreadable file.' } })()
          : await gitDiffForFile(currentDirectory, file, hasCommits)
      } else if (name === 'read_file') {
        try { content = fs.readFileSync(path.resolve(currentDirectory, file), 'utf8').slice(0, 12000) } catch { content = 'File is binary, unavailable or unreadable.' }
      }
      messages.push({ role: 'tool', tool_name: name, content: String(content).slice(0, 16000) })
    }
  }
  if (operation === 'planned-commits') {
    try {
      const plan = JSON.parse(finalContent.replace(/^```json\s*|\s*```$/g, '').trim())
      if (!Array.isArray(plan.commits) || !plan.commits.length) throw new Error('The AI returned no planned commits')
      const allowed = new Set(normalizedSelected)
      const used = new Set()
      plan.commits = plan.commits.map(commit => {
        const commitFiles = Array.isArray(commit.files) ? commit.files.map(file => String(file).replaceAll('\\', '/')) : []
        if (!commitFiles.length || !String(commit.message || '').trim()) throw new Error('Each planned commit needs files and a message')
        commitFiles.forEach(file => { if (!allowed.has(file) || used.has(file)) throw new Error(`Invalid or duplicated planned file: ${file}`); used.add(file) })
        return { files: commitFiles, message: String(commit.message).trim() }
      })
      if (used.size !== allowed.size) throw new Error('The plan does not cover every selected file')
      return plan
    } catch (error) { throw new Error(`Invalid planned commits response: ${error.message}`) }
  }
  const message = finalContent.split(/\r?\n/)[0].replace(/^['"`]+|['"`]+$/g, '').trim()
  if (!message) throw new Error(`${AI_PROVIDER_LABELS[aiProvider()]} returned an empty commit message. Check the provider configuration and try again.`)
  return message
})
ipcMain.handle('get-diff', async (_, file) => {
  if (!currentDirectory) throw new Error('No directory selected')
  if (typeof file !== 'string' || !file || file.includes('..')) throw new Error('Invalid file path')
  return new Promise((resolve, reject) => execFile('git', ['-C', currentDirectory, 'diff', '--', file], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout || 'No diff available for this file.')))
})
ipcMain.handle('get-stashes', async () => {
  if (!currentDirectory) return []
  const list = await new Promise((resolve, reject) => execFile('git', ['-C', currentDirectory, 'stash', 'list', '--format=%gd|%ai|%s'], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)))
  const entries = list.split(/\r?\n/).filter(Boolean)
  return Promise.all(entries.map(async line => {
    const [ref, date, ...messageParts] = line.split('|')
    const files = await new Promise(resolve => execFile('git', ['-C', currentDirectory, 'stash', 'show', '--name-only', '--format=', ref], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (_, stdout) => resolve(stdout.split(/\r?\n/).filter(Boolean))))
    return { ref, date, message: messageParts.join('|'), files }
  }))
})
ipcMain.handle('get-history', async () => {
  if (!currentDirectory) return []
  const output = await runGit(currentDirectory, ['log', '-n', '100', '--date=iso-strict', '--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e'])
  const commits = output.split('\x1e').map(value => value.trim()).filter(Boolean).map(value => {
    const [hash, shortHash, author, date, message] = value.split('\x1f')
    return { hash, shortHash, author, date, message }
  })
  let remoteTags = new Set()
  try { remoteTags = new Set((await runGit(currentDirectory, ['ls-remote', '--tags', 'origin'])).split(/\r?\n/).map(line => line.match(/refs\/tags\/(.+?)(?:\^\{\})?$/)?.[1]).filter(Boolean)) } catch {}
  return Promise.all(commits.map(async commit => { const tags = (await runGit(currentDirectory, ['tag', '--points-at', commit.hash])).split(/\r?\n/).filter(Boolean); return { ...commit, tags, pushedTags: tags.filter(name => remoteTags.has(name)) } }))
})
ipcMain.handle('get-pending-commits', async () => {
  if (!currentDirectory) return []
  let output = ''
  try { output = await runGit(currentDirectory, ['log', '@{u}..HEAD', '--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s', '--date=iso-strict']) } catch { return [] }
  return output.split(/\r?\n/).filter(Boolean).map(line => { const [hash, shortHash, author, date, message] = line.split('\x1f'); return { hash, shortHash, author, date, message } })
})
ipcMain.handle('amend-commit-message', async (_, message) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const value = String(message || '').trim()
  if (!value) throw new Error('The commit message is empty')
  await runGit(currentDirectory, ['commit', '--amend', '-m', value])
  await publish('post-commit')
  return { ok: true }
})
ipcMain.handle('generate-release-tag', async () => {
  if (!currentDirectory) throw new Error('No directory selected')
  assertAiConfigured()
  const base = await runGit(currentDirectory, ['describe', '--tags', '--abbrev=0']).catch(() => '')
  const range = base ? `${base}..HEAD` : 'HEAD'
  const changes = await runGit(currentDirectory, ['log', range, '--format=%s%n%b']).catch(() => '')
  const fileSummary = await runGit(currentDirectory, ['diff', '--stat', range]).catch(() => '')
  const fileChanges = await runGit(currentDirectory, ['log', range, '--name-status', '--format=--- %h %s']).catch(() => '')
  const changeSummary = changes.trim() || 'No new commits were found since the latest tag. Propose the next patch release only if the user explicitly wants to create one.'
  const prompt = `TASK: Propose a release tag and a complete release message for ALL Git changes shown below.
Return ONLY valid JSON with exactly these fields:
{"name":"v1.5.0","message":"Release v1.5.0"}
The name MUST be a semantic version tag starting with v. Increment the latest version ${base || 'v0.0.0'} according to the complete change set. The message must summarize all important user-visible changes, fixes and technical improvements, not just the last commit. Write it in ${aiSettings.language}.
The initial context contains summaries only. Use get_file_diff for relevant changed files and read_file only when the diff needs additional context. Inspect enough files to cover the complete change set, but do not read every full file by default.

COMMITS AND MESSAGES:
${changeSummary.slice(0, 18000)}

FILES CHANGED:
${fileChanges.slice(0, 18000)}

DIFF STAT:
${fileSummary.slice(0, 6000)}`
  const tools = [
    { type: 'function', function: { name: 'get_file_diff', description: 'Get the release diff for one changed repository-relative file.', parameters: { type: 'object', required: ['file'], properties: { file: { type: 'string' } } } } },
    { type: 'function', function: { name: 'read_file', description: 'Read one changed repository-relative file when its diff is insufficient.', parameters: { type: 'object', required: ['file'], properties: { file: { type: 'string' } } } } }
  ]
  const messages = [{ role: 'user', content: prompt }]
  let finalContent = ''
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const result = await requestAiChat({ model: providerConfig().model, messages, tools, stream: false })
    const assistant = result.message || {}
    messages.push(assistant)
    const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : []
    if (!calls.length) { finalContent = String(assistant.content || '').trim(); break }
    for (const call of calls) {
      const name = call?.function?.name
      const rawArgs = call?.function?.arguments
      const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {})
      const file = String(args.file || '')
      if (!file || file.includes('..') || path.isAbsolute(file)) throw new Error('AI requested an invalid repository file')
      let content = 'Unknown tool'
      if (name === 'get_file_diff') content = await runGit(currentDirectory, ['diff', range, '--no-ext-diff', '--unified=2', '--', file]).catch(() => 'No diff available for this file.')
      if (name === 'read_file') {
        try { content = fs.readFileSync(path.resolve(currentDirectory, file), 'utf8').slice(0, 12000) } catch { content = 'File is binary, unavailable or unreadable.' }
      }
      messages.push({ role: 'tool', tool_name: name, content: String(content).slice(0, 16000) })
    }
  }
  if (!finalContent) {
    const finalResult = await requestAiChat({ model: providerConfig().model, messages: [...messages, { role: 'user', content: 'Stop inspecting files now. Return ONLY the final valid JSON object with exactly the fields name and message. Do not call tools and do not include any explanation.' }], stream: false })
    finalContent = String(finalResult.message?.content || '').trim()
  }
  const cleaned = finalContent.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim()
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  const raw = jsonMatch ? jsonMatch[0] : cleaned
  try {
    const parsed = JSON.parse(raw)
    if (!/^v\d+\.\d+\.\d+$/.test(parsed.name) || !String(parsed.message || '').trim()) throw new Error()
    return { name: parsed.name, message: String(parsed.message).trim(), base, hasChanges: Boolean(changes.trim()) }
  } catch { throw new Error(`${AI_PROVIDER_LABELS[aiProvider()]} returned an invalid release tag proposal`) }
})
ipcMain.handle('create-tag', async (_, { name, commit, message, annotated = true } = {}) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const tagName = String(name || '').trim()
  const target = String(commit || '').trim()
  if (!tagName || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tagName) || tagName.includes('..')) throw new Error('Invalid tag name')
  if (!target || (target !== 'HEAD' && !/^[0-9a-f]{7,40}$/i.test(target))) throw new Error('Invalid commit')
  if (annotated) {
    const tagMessage = String(message || '').trim()
    if (!tagMessage) throw new Error('The annotated tag message is empty')
    await runGit(currentDirectory, ['tag', '-a', tagName, target, '-m', tagMessage])
  } else await runGit(currentDirectory, ['tag', tagName, target])
  return { ok: true }
})
ipcMain.handle('delete-tag', async (_, name) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const tagName = String(name || '').trim()
  if (!tagName || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tagName) || tagName.includes('..')) throw new Error('Invalid tag name')
  await runGit(currentDirectory, ['tag', '-d', tagName])
  return { ok: true }
})
ipcMain.handle('push-tag', async (_, name) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const tagName = String(name || '').trim()
  if (!tagName || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tagName) || tagName.includes('..')) throw new Error('Invalid tag name')
  return runGitRemoteTag(tagName)
})
ipcMain.handle('stash-selected', async (_, { files, message }) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const selected = Array.isArray(files) ? files.filter(file => typeof file === 'string' && file && !file.includes('..')) : []
  const stashMessage = String(message || '').trim()
  if (!selected.length) throw new Error('Select at least one file')
  if (!stashMessage) throw new Error('The stash message is empty')
  const result = await runGitWithPathspec(currentDirectory, ['stash', 'push', '-u', '-m', stashMessage], selected, 60000)
  await publish('stash-created')
  return result
})
ipcMain.handle('open-in-explorer', async () => {
  if (!currentDirectory) throw new Error('No directory selected')
  const error = await shell.openPath(currentDirectory)
  if (error) throw new Error(error)
  return { ok: true }
})
ipcMain.handle('run-shell-command', async (_, command) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const value = String(command || '').trim()
  if (!value) throw new Error('Enter a shell command')
  const commandShell = shellCommand()
  sendOperationLog(`${commandShell.label} ${currentDirectory}> ${value}`)
  return new Promise((resolve, reject) => {
    execFile(commandShell.file, [...commandShell.args, value], { cwd: currentDirectory, windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024 }, async (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('').trim()
      if (output) sendOperationLog(output)
      if (error) return reject(new Error(output || error.message))
      try { await publish('shell-command') } catch {}
      resolve(output)
    })
  })
})
ipcMain.handle('start-terminal', async (_, directory) => {
  if (!directory || !fs.existsSync(directory)) throw new Error('No directory selected')
  stopTerminal()
  const sessionId = terminalSession
  const commandShell = terminalShell()
  const processRef = pty.spawn(commandShell.file, commandShell.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: directory,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    useConpty: true,
    useConptyDll: process.platform === 'win32',
  })
  terminalProcess = processRef
  processRef.onData(data => { if (terminalSession === sessionId && terminalProcess === processRef && win && !win.isDestroyed()) win.webContents.send('terminal-data', data) })
  processRef.onExit(({ exitCode }) => { if (terminalSession === sessionId && terminalProcess === processRef) { if (win && !win.isDestroyed()) win.webContents.send('terminal-exit', exitCode); terminalProcess = null } })
  return { ok: true, sessionId }
})
ipcMain.handle('write-terminal', (_, data, sessionId) => { if (terminalProcess && sessionId === terminalSession && typeof data === 'string') terminalProcess.write(data); return true })
ipcMain.handle('resize-terminal', (_, { cols, rows } = {}, sessionId) => { if (terminalProcess && sessionId === terminalSession) terminalProcess.resize(Math.max(20, Number(cols) || 120), Math.max(5, Number(rows) || 30)); return true })
ipcMain.handle('stop-terminal', (_, sessionId) => { stopTerminal(sessionId ?? null); return true })
ipcMain.handle('commit-selected', async (_, { files, message, amend = false }) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const selected = Array.isArray(files) ? files.filter(file => typeof file === 'string' && file && !file.includes('..')) : []
  const commitMessage = String(message || '').trim()
  if (!selected.length) throw new Error('Select at least one file')
  if (!commitMessage) throw new Error('The commit message is empty')
  sendOperationLog('Staging selected changes…')
  await runGitWithPathspec(currentDirectory, ['add'], selected, 30000)
  sendOperationLog(amend ? 'Amending commit…' : 'Creating commit…')
  const output = await new Promise((resolve, reject) => execFile('git', ['-C', currentDirectory, 'commit', ...(amend ? ['--amend'] : []), '-m', commitMessage], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim())))
  // Refreshing Git status can still be expensive in a large repository. The
  // commit is complete, so let the renderer continue while the refresh runs.
  void publish('post-commit')
  return { ok: true, output: String(output || '') }
})
ipcMain.handle('commit-planned', async (_, plan) => {
  if (!currentDirectory || !Array.isArray(plan?.commits) || !plan.commits.length) throw new Error('Invalid planned commits')
  const available = new Set((await gitChanges(currentDirectory)).map(change => change.file.replaceAll('\\', '/')))
  const used = new Set()
  const committed = []
  try {
    for (const item of plan.commits) {
      const files = Array.isArray(item.files) ? item.files.map(file => String(file).replaceAll('\\', '/')) : []
      const message = String(item.message || '').trim()
      if (!files.length || !message) throw new Error('Each planned commit needs files and a message')
      if (files.some(file => !file || path.isAbsolute(file) || file.split('/').some(part => part === '..') || !available.has(file) || used.has(file))) throw new Error('Planned commits contain an invalid or duplicated file')
      files.forEach(file => used.add(file))
      sendOperationLog(`Creating planned commit: ${message}`)
      // -A records deletions as well as additions. --only keeps files already
      // staged for another planned commit out of the current commit.
      await runGitWithPathspec(currentDirectory, ['add', '-A'], files, 30000)
      await runGitWithPathspec(currentDirectory, ['commit', '--only', '-m', message], files, 30000)
      committed.push({ files, message })
    }
  } catch (error) {
    await publish('post-commit').catch(() => {})
    return { ok: false, commits: committed, error: error.message }
  }
  void publish('post-commit')
  return { ok: true, commits: committed }
})
ipcMain.handle('move-selected', async (_, { files } = {}) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const selected = Array.isArray(files) ? files.filter(file => typeof file === 'string' && file && !file.includes('..')) : []
  if (selected.length !== 2) throw new Error('Select exactly one deleted file and one added file')
  const changes = await gitChanges(currentDirectory)
  const selectedChanges = changes.filter(change => selected.includes(change.file))
  if (selectedChanges.length !== 2 || !selectedChanges.some(change => change.status === 'Deleted') || !selectedChanges.some(change => change.status === 'Added')) {
    throw new Error('Select exactly one deleted file and one added file')
  }
  await runGit(currentDirectory, ['add', '-A', '--', ...selected])
  await publish('file-move')
  return { ok: true }
})
ipcMain.handle('refresh', async () => publish('post-commit'))
async function runGitRemote(command) {
  if (!currentDirectory) throw new Error('No directory selected')
  sendOperationLog(`${command === 'pull' ? 'Pull' : 'Push'} started`)
  let args = ['-C', currentDirectory, command, '--progress']
  if (command === 'push') {
    const branch = await gitCurrentBranch(currentDirectory)
    const hasUpstream = await runGit(currentDirectory, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).then(() => true).catch(() => false)
    if (!hasUpstream) args = ['-C', currentDirectory, 'push', '--progress', '--set-upstream', 'origin', branch]
  }
  const output = await runGitStreaming(args)
  sendOperationLog(`${command === 'pull' ? 'Pull' : 'Push'} completed`)
  return output || `${command} completed`
}
async function runGitRemoteTag(tagName) {
  sendOperationLog(`Pushing tag ${tagName} started`)
  const output = await runGitStreaming(['-C', currentDirectory, 'push', 'origin', tagName])
  sendOperationLog(`Pushing tag ${tagName} completed`)
  return output || `Tag ${tagName} pushed`
}
ipcMain.handle('git-pull', async () => { const result = await runGitRemote('pull'); await publish('git-pull'); return result })
ipcMain.handle('git-push', async () => { const result = await runGitRemote('push'); await publish('git-push'); return result })
ipcMain.handle('get-branches', async () => {
  if (!currentDirectory) return { current: '', local: [], remote: [], remoteUrl: '' }
  const [localOutput, remoteOutput, remoteUrl] = await Promise.all([
    runGit(currentDirectory, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    runGit(currentDirectory, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
    runGit(currentDirectory, ['remote', 'get-url', '--push', 'origin']).catch(() => runGit(currentDirectory, ['remote', 'get-url', 'origin']).catch(() => '')),
  ])
  const local = localOutput.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  const remote = remoteOutput.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.endsWith('/HEAD'))
  return { current: await gitCurrentBranch(currentDirectory), local, remote, remoteUrl: remoteUrl.trim() }
})
ipcMain.handle('connect-remote', async (_, remoteUrl) => {
  if (!currentDirectory) throw new Error('No directory selected')
  let url = String(remoteUrl || '').trim()
  if (/^git@[^/:]+\//.test(url)) url = url.replace('/', ':')
  if (/^git@[^:]+:[^/]+\/.+[^/]$/.test(url) && !url.endsWith('.git')) url += '.git'
  if (!url) throw new Error('Enter a remote repository URL')
  const existing = await runGit(currentDirectory, ['remote', 'get-url', 'origin']).catch(() => '')
  if (existing) await runGit(currentDirectory, ['remote', 'set-url', 'origin', url])
  else await runGit(currentDirectory, ['remote', 'add', 'origin', url])
  await runGit(currentDirectory, ['remote', 'set-url', '--push', 'origin', url])
  sendOperationLog(`Remote origin connected: ${url}`)
  return url
})
ipcMain.handle('switch-branch', async (_, { target, newBranch, base, remote = false, stash = false } = {}) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const branchName = String(newBranch || '').trim()
  const switchTarget = String(target || '').trim()
  if (!branchName && !switchTarget) throw new Error('No branch selected')
  if (stash) await runGit(currentDirectory, ['stash', 'push', '-u', '-m', `Auto stash before switching branches`], 60000)
  if (branchName) {
    const baseName = String(base || '').trim()
    await runGit(currentDirectory, baseName ? ['switch', '-c', branchName, baseName] : ['switch', '-c', branchName])
  } else if (remote) {
    const localName = switchTarget.slice(switchTarget.indexOf('/') + 1)
    await runGit(currentDirectory, ['switch', '--track', '-c', localName, switchTarget])
  } else {
    await runGit(currentDirectory, ['switch', switchTarget])
  }
  await publish('branch-switch')
  return { branch: await gitCurrentBranch(currentDirectory) }
})
ipcMain.handle('unstash', async (_, ref) => {
  if (!currentDirectory || !ref) throw new Error('No stash selected')
  const result = await runGit(currentDirectory, ['stash', 'pop', ref], 60000)
  await publish('stash-pop')
  return result
})
ipcMain.handle('unstash-many', async (_, refs) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const selected = Array.isArray(refs) ? refs.filter(ref => typeof ref === 'string' && /^stash@\{\d+\}$/.test(ref)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0])) : []
  if (!selected.length) throw new Error('No stash selected')
  for (const ref of selected) await runGit(currentDirectory, ['stash', 'pop', ref], 60000)
  await publish('stash-pop')
  return { ok: true }
})
ipcMain.handle('generate-stash-merge-message', async (_, refs) => {
  if (!currentDirectory) throw new Error('No directory selected')
  assertAiConfigured()
  const selected = Array.isArray(refs) ? refs.filter(ref => typeof ref === 'string') : []
  const list = await runGit(currentDirectory, ['stash', 'list', '--format=%gd|%s'])
  const messages = list.split(/\r?\n/).filter(Boolean).filter(line => selected.includes(line.split('|')[0])).map(line => line.split('|').slice(1).join('|'))
  const prompt = `TASK: Write exactly one Conventional Commits-style message that summarizes these merged work-in-progress stashes.
MANDATORY LANGUAGE: ${aiSettings.language}. The description MUST be written entirely in ${aiSettings.language}.
FORMAT: wip(<scope>): <description>
OUTPUT RULES: Return one line only. No markdown, quotes, explanation, prefix or suffix.

STASH MESSAGES:
${messages.join('\n')}`
  const result = await requestAiGenerate({ model: providerConfig().model, prompt, stream: false })
  const message = String(result.response || '').trim().split(/\r?\n/)[0].replace(/^['"`]+|['"`]+$/g, '').trim()
  if (!message) throw new Error(`${AI_PROVIDER_LABELS[aiProvider()]} returned an empty stash merge message.`)
  return message
})
ipcMain.handle('merge-stashes', async (_, { refs, message } = {}) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const selected = Array.isArray(refs) ? refs.filter(ref => typeof ref === 'string' && /^stash@\{\d+\}$/.test(ref)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0])) : []
  const stashMessage = String(message || '').trim()
  if (selected.length < 2) throw new Error('Select at least two stashes to merge')
  if (!stashMessage) throw new Error('The stash merge message is empty')
  const status = await runGit(currentDirectory, ['status', '--porcelain'])
  if (status.trim()) throw new Error('Commit or stash current changes before merging stashes')
  for (const ref of selected.slice().reverse()) await runGit(currentDirectory, ['stash', 'apply', ref], 60000)
  await runGit(currentDirectory, ['stash', 'push', '-u', '-m', stashMessage], 60000)
  for (const ref of selected) {
    const originalIndex = Number(ref.match(/\d+/)[0])
    await runGit(currentDirectory, ['stash', 'drop', `stash@{${originalIndex + 1}}`], 60000)
  }
  await publish('stash-merge')
  return { ok: true }
})
ipcMain.handle('unstash-files', async (_, { ref, files } = {}) => {
  if (!currentDirectory || !ref) throw new Error('No stash selected')
  const selected = Array.isArray(files) ? files.filter(file => typeof file === 'string' && file && !file.includes('..')) : []
  if (!selected.length) throw new Error('Select at least one stash file')
  const indexPath = path.join(os.tmpdir(), `pulse-stash-index-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  try {
    const stashHash = await runGit(currentDirectory, ['rev-parse', ref])
    const baseHash = await runGit(currentDirectory, ['rev-parse', `${stashHash}^1`])
    const indexParent = await runGit(currentDirectory, ['rev-parse', `${stashHash}^2`])
    const message = await runGit(currentDirectory, ['show', '-s', '--format=%s', stashHash])
    const stashFiles = (await runGit(currentDirectory, ['stash', 'show', '--include-untracked', '--name-only', '--format=', ref])).split(/\r?\n/).filter(Boolean)
    await runGit(currentDirectory, ['restore', `--source=${ref}`, '--worktree', '--', ...selected], 60000)
    if (stashFiles.length > 0 && stashFiles.every(file => selected.includes(file))) {
      await runGit(currentDirectory, ['stash', 'drop', ref], 60000)
      await publish('stash-files-restore')
      return { ok: true, emptied: true }
    }
    await runGitWithEnv(currentDirectory, ['read-tree', `${stashHash}^{tree}`], { GIT_INDEX_FILE: indexPath })
    for (const file of selected) {
      const baseEntry = await runGit(currentDirectory, ['ls-tree', baseHash, '--', file])
      if (!baseEntry) await runGitWithEnv(currentDirectory, ['update-index', '--force-remove', '--', file], { GIT_INDEX_FILE: indexPath })
      else {
        const [mode, , object] = baseEntry.split(/\s+/)
        await runGitWithEnv(currentDirectory, ['update-index', '--add', '--cacheinfo', `${mode},${object},${file}`], { GIT_INDEX_FILE: indexPath })
      }
    }
    const newTree = await runGitWithEnv(currentDirectory, ['write-tree'], { GIT_INDEX_FILE: indexPath })
    const newStash = await runGit(currentDirectory, ['commit-tree', newTree, '-p', baseHash, '-p', indexParent, '-m', message])
    await runGit(currentDirectory, ['stash', 'store', '-m', message, newStash])
    const stashEntries = (await runGit(currentDirectory, ['stash', 'list', '--format=%H'])).split(/\r?\n/).filter(Boolean)
    const oldIndex = stashEntries.indexOf(stashHash)
    if (oldIndex >= 0) await runGit(currentDirectory, ['stash', 'drop', `stash@{${oldIndex}}`])
    await publish('stash-files-restore')
    return { ok: true }
  } finally {
    try { fs.unlinkSync(indexPath) } catch {}
  }
})
ipcMain.handle('delete-stash', async (_, ref) => {
  if (!currentDirectory || !ref) throw new Error('No stash selected')
  const result = await runGit(currentDirectory, ['stash', 'drop', ref], 60000)
  await publish('stash-delete')
  return result
})
ipcMain.handle('delete-stashes', async (_, refs) => {
  if (!currentDirectory || !Array.isArray(refs) || !refs.length) throw new Error('No stashes selected')
  const orderedRefs = refs.slice().sort((a, b) => {
    const index = ref => Number(String(ref).match(/stash@\{(\d+)\}/)?.[1] ?? -1)
    return index(b) - index(a)
  })
  let result = ''
  for (const ref of orderedRefs) result = await runGit(currentDirectory, ['stash', 'drop', ref], 60000)
  await publish('stash-delete')
  return result
})
ipcMain.handle('get-lfs-config', async () => {
  if (!currentDirectory) return { patterns: [], files: [] }
  const [trackOutput, filesOutput] = await Promise.all([
    runGit(currentDirectory, ['lfs', 'track']),
    runGit(currentDirectory, ['lfs', 'ls-files', '--name-only']),
  ])
  const patterns = parseLfsPatterns(trackOutput)
  const files = filesOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return { patterns, files }
})
ipcMain.handle('track-lfs', async (_, pattern) => {
  if (!currentDirectory || !String(pattern || '').trim()) throw new Error('Enter an LFS pattern')
  const result = await runGit(currentDirectory, ['lfs', 'track', String(pattern).trim()])
  await publish('lfs-track')
  return result
})
ipcMain.handle('untrack-lfs', async (_, pattern) => {
  if (!currentDirectory || !String(pattern || '').trim()) throw new Error('No LFS pattern selected')
  const result = await runGit(currentDirectory, ['lfs', 'untrack', String(pattern).trim()])
  await publish('lfs-untrack')
  return result
})
ipcMain.handle('set-lfs-enabled', async (_, { directory, enabled } = {}) => {
  const target = typeof directory === 'string' && directory ? directory : currentDirectory
  if (!target) throw new Error('No directory selected')
  const active = Boolean(enabled)
  const result = await runGit(target, active ? ['lfs', 'install', '--local'] : ['lfs', 'uninstall', '--local'])
  const project = projects.find(item => item.path === target)
  if (project) { project.gitLfs = active; persistProjects() }
  if (target === currentDirectory) await publish(active ? 'lfs-enabled' : 'lfs-disabled')
  return { ok: true, enabled: active, output: result }
})
ipcMain.handle('revert-files', async (_, files) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const selected = Array.isArray(files) ? files.filter(file => typeof file === 'string' && file && !file.includes('..')) : []
  if (!selected.length) throw new Error('Select at least one file')
  await runGit(currentDirectory, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...selected], 60000).catch(async error => {
    if (!/pathspec|did not match any file/i.test(error.message)) throw error
  })
  await runGit(currentDirectory, ['clean', '-f', '--', ...selected], 60000).catch(() => {})
  await publish('revert-files')
  return { ok: true }
})
ipcMain.handle('get-projects', () => projects)
ipcMain.handle('add-project', (_, project) => { const directory = typeof project === 'string' ? project : project?.path; if (!directory) return projects; const metadata = typeof project === 'string' ? {} : project; const existing = projects.find(item => item.path === directory); if (existing) Object.assign(existing, { name: metadata.name || existing.name, icon: metadata.icon || existing.icon || findProjectIcon(directory), lastOpened: metadata.lastOpened || existing.lastOpened || 0 }); else projects.unshift({ path: directory, name: metadata.name || path.basename(directory), icon: metadata.icon || findProjectIcon(directory), lastOpened: metadata.lastOpened || 0 }); persistProjects(); return projects })
ipcMain.handle('update-project', (_, originalPath, project) => { const index = projects.findIndex(item => item.path === originalPath); if (index < 0 || !project?.path) return projects; projects[index] = { ...projects[index], ...project }; persistProjects(); return projects })
ipcMain.handle('remove-project', (_, directory) => { projects = projects.filter(project => project.path !== directory); persistProjects(); return projects })
ipcMain.handle('stop-watching', () => {
  if (watcher) watcher.close()
  if (publishTimer) { clearTimeout(publishTimer); publishTimer = null }
  watchGeneration += 1
  publishQueued = false
  watcher = null
  currentDirectory = null
  return { ok: true }
})

app.whenReady().then(() => { aiSettings = loadSettings(); projects = loadProjects(); lastDirectoryDialogPath = loadDialogState().lastDirectoryDialogPath || ''; createWindow(); buildMenu() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
