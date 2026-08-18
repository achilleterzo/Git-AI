const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } = require('electron')
const { execFile } = require('child_process')
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
let lastDirectoryDialogPath = ''

const PUBLISH_DEBOUNCE_MS = 200

function sendOperationLog(message) {
  if (win && !win.isDestroyed()) win.webContents.send('operation-log', { message: String(message), at: new Date().toISOString() })
}

function sendRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return
  try { win.webContents.send(channel, JSON.parse(JSON.stringify(payload))) } catch (error) { console.error(`[IPC] Could not send ${channel}:`, error.message) }
}

function stopTerminal() {
  if (!terminalProcess) return
  try { terminalProcess.kill() } catch {}
  terminalProcess = null
}

function windowStatePath() { return path.join(app.getPath('userData'), 'window-state.json') }
function settingsPath() { return path.join(app.getPath('userData'), 'settings.json') }
function projectsPath() { return path.join(app.getPath('userData'), 'projects.json') }
function dialogStatePath() { return path.join(app.getPath('userData'), 'dialog-state.json') }
function loadDialogState() { try { return JSON.parse(fs.readFileSync(dialogStatePath(), 'utf8')) } catch { return {} } }
function saveDialogState() { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(dialogStatePath(), JSON.stringify({ lastDirectoryDialogPath }, null, 2)) }
function loadProjects() { try { return JSON.parse(fs.readFileSync(projectsPath(), 'utf8')).map(project => typeof project === 'string' ? { path: project, icon: findProjectIcon(project), lastOpened: 0 } : { lastOpened: 0, ...project }).filter(project => typeof project?.path === 'string' && project.path && fs.existsSync(project.path)) } catch { return [] } }
function persistProjects() { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(projectsPath(), JSON.stringify(projects, null, 2)) }
function loadSettings() {
  try { return { endpoint: 'http://localhost:11434', model: '', language: 'English', ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) } } catch { return { endpoint: 'http://localhost:11434', model: '', language: 'English' } }
}
function saveSettings(settings) {
  aiSettings = { endpoint: String(settings.endpoint || '').replace(/\/$/, ''), model: String(settings.model || ''), language: String(settings.language || 'English') }
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(aiSettings, null, 2))
  return aiSettings
}
function requestJson(urlString, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const client = url.protocol === 'https:' ? https : http
    console.log('[Ollama] request', JSON.stringify({ url: urlString, method: options.method || 'GET', payload: body }, null, 2))
    const request = client.request(url, { method: options.method || 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}) }, timeout: 120000 }, response => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { data += chunk })
      response.on('end', () => {
        console.log('[Ollama] response', JSON.stringify({ url: urlString, status: response.statusCode, body: data }, null, 2))
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`HTTP ${response.statusCode}`))
        try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON response')) }
      })
    })
    request.on('error', error => { console.error('[Ollama] request error', error); reject(error) })
    request.on('timeout', () => { const error = new Error('Ollama request timed out after 120 seconds'); console.error('[Ollama] timeout', error.message); request.destroy(error) })
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
  const candidates = (Array.isArray(releases) ? releases : [releases]).filter(release => !release.draft && release.tag_name && releaseVersion(release.tag_name))
  const release = candidates.sort((left, right) => compareReleaseVersions(right.tag_name, left.tag_name))[0]
  if (!release) throw new Error('No published GitHub release found')
  const result = { version: releaseVersion(release.tag_name), tag: release.tag_name, url: release.html_url, name: release.name || release.tag_name, notes: release.body || '' }
  console.log('[Update] latest release', result)
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
    const script = `Get-ChildItem -LiteralPath '${directory.replaceAll("'", "''")}' -File -Recurse -Force | ForEach-Object { @{ path=$_.FullName; size=$_.Length; modified=$_.LastWriteTime.ToString('o') } } | ConvertTo-Json -Compress`
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error)
      try {
        const parsed = stdout.trim() ? JSON.parse(stdout) : []
        resolve((Array.isArray(parsed) ? parsed : [parsed]).map((f) => ({ path: f.path, size: Number(f.size), modified: f.modified })))
      } catch (e) { reject(e) }
    })
  })
}
function gitChanges(directory) {
  return new Promise((resolve, reject) => execFile('git', ['-C', directory, 'status', '--porcelain=v1', '--untracked-files=all'], { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(stderr.trim() || error.message))
    resolve(stdout.split(/\r?\n/).filter(Boolean).map(line => {
      const code = line.slice(0, 2)
      const file = line.slice(3).replace(/^"|"$/g, '')
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
  return new Promise((resolve, reject) => execFile('git', ['-C', directory, ...args], { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || stdout.trim() || error.message)) : resolve(stdout.trim())) )
}
function runGitWithEnv(directory, args, env, timeout = 120000) {
  return new Promise((resolve, reject) => execFile('git', ['-C', directory, ...args], { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || stdout.trim() || error.message)) : resolve(stdout.trim())))
}
function gitAheadBehind(directory) {
  return new Promise(resolve => execFile('git', ['-C', directory, 'rev-list', '--left-right', '--count', '@{u}...HEAD'], { windowsHide: true, timeout: 10000 }, (error, stdout) => {
    if (error) return resolve({ incoming: 0, outgoing: 0 })
    const [incoming, outgoing] = stdout.trim().split(/\s+/).map(value => Number.parseInt(value, 10) || 0)
    resolve({ incoming, outgoing })
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
function gitLfsAvailable(directory) {
  return new Promise(resolve => execFile('git', ['-C', directory, 'config', '--local', '--get-regexp', '^filter\\.lfs\\.'], { windowsHide: true, timeout: 10000 }, error => resolve(!error)))
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
    const results = await Promise.allSettled([shellSnapshot(directory), gitChanges(directory), gitAheadBehind(directory), gitCurrentBranch(directory), gitLfsAvailable(directory), gitHasCommits(directory)])
    const files = results[0].status === 'fulfilled' ? results[0].value : []
    const changes = results[1].status === 'fulfilled' ? results[1].value : []
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
    const scanError = results[0].status === 'rejected' ? `File scan: ${results[0].reason.message}` : null
    const gitError = results[1].status === 'rejected' ? `Git: ${results[1].reason.message}` : null
    if (directory === currentDirectory && generation === watchGeneration) {
      const aheadBehind = results[2].status === 'fulfilled' ? results[2].value : { incoming: 0, outgoing: 0 }
      const branch = results[3].status === 'fulfilled' ? results[3].value : ''
      const gitLfs = results[4].status === 'fulfilled' ? results[4].value : false
      const hasCommits = results[5].status === 'fulfilled' ? results[5].value : false
      const project = projects.find(item => item.path === directory)
      if (project && project.gitLfs !== gitLfs) { project.gitLfs = gitLfs; persistProjects() }
      const update = { directory, projectIcon: findProjectIcon(directory), files, changes, incomingCommits: aheadBehind.incoming, outgoingCommits: aheadBehind.outgoing, branch, gitLfs, hasCommits, gitOk: results[1].status === 'fulfilled', reason, error: [scanError, gitError].filter(Boolean).join(' | ') || null, at: new Date().toISOString() }
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
  win = new BrowserWindow({ ...bounds, minWidth: 900, minHeight: 620, icon: path.join(__dirname, '../assets/pulse-git-ai.png'), backgroundColor: '#08111f', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } })
  if (saved?.isMaximized) win.maximize()
  win.on('resize', scheduleSaveWindowState)
  win.on('move', scheduleSaveWindowState)
  win.on('close', saveWindowState)
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL)
  else win.loadFile(path.join(__dirname, '../dist/index.html'))
  win.webContents.on('did-fail-load', (_, code, description) => console.error(`Renderer load failed (${code}): ${description}`))
}
async function startWatching(directory) {
  try {
    await ensureGitRepository(directory)
  } catch (error) {
    if (isDirectoryEmpty(directory)) {
      const emptyError = new Error('The selected directory is empty and is not a Git repository')
      emptyError.code = 'EMPTY_DIRECTORY_NOT_REPOSITORY'
      throw emptyError
    }
    throw error
  }
  if (watcher) watcher.close()
  if (publishTimer) { clearTimeout(publishTimer); publishTimer = null }
  watchGeneration += 1
  publishQueued = false
  currentDirectory = directory
  const generation = watchGeneration
  watcher = fs.watch(directory, { recursive: true }, (_, filename) => {
    if (generation === watchGeneration) schedulePublish(filename ? String(filename) : 'change')
  })
  watcher.on('error', error => {
    if (error?.code === 'ENOENT' || !fs.existsSync(directory)) schedulePublish('directory-removed')
  })
  await publish('started', generation)
}
function openDirectory() { dialog.showOpenDialog(win, { properties: ['openDirectory'] }).then(result => { if (result.filePaths[0]) startWatching(result.filePaths[0]) }) }
function buildMenu() { Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'File', submenu: [{ label: 'Open directory…', accelerator: 'CmdOrCtrl+O', click: openDirectory }, { label: 'Refresh Git status', accelerator: 'CmdOrCtrl+R', click: () => publish('manual-refresh') }, { type: 'separator' }, { label: 'Settings…', click: () => win.webContents.send('open-settings') }, { label: 'About Pulse Git AI', click: () => win.webContents.send('open-about') }, { type: 'separator' }, { role: 'quit' }] }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggledevtools' }] }])) }

ipcMain.handle('choose-directory', async (_, initialPath) => { const fallback = projects.slice().sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))[0]?.path; const defaultPath = [initialPath, lastDirectoryDialogPath, currentDirectory, fallback].find(value => value && fs.existsSync(value)); const result = await dialog.showOpenDialog(win, { defaultPath, properties: ['openDirectory'] }); const selected = result.filePaths[0] || null; if (selected) { lastDirectoryDialogPath = selected; saveDialogState() } return selected })
ipcMain.handle('choose-project-icon', async (_, projectDirectory) => { const defaultPath = projectDirectory && fs.existsSync(projectDirectory) ? projectDirectory : undefined; const result = await dialog.showOpenDialog(win, { defaultPath, properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'ico', 'svg'] }] }); return result.filePaths[0] ? readIconFile(result.filePaths[0]) : null })
ipcMain.handle('get-project-icon', (_, directory) => directory ? findProjectIcon(directory) : null)
ipcMain.handle('start-watching', async (_, directory) => { await startWatching(directory); return { ok: true } })
ipcMain.handle('initialize-repository', async (_, directory) => { sendOperationLog(`Initializing Git repository in ${directory}`); await runGit(directory, ['init'], 30000); sendOperationLog('Git repository initialized'); await startWatching(directory); sendOperationLog('Watcher started'); return { ok: true } })
ipcMain.handle('checkout-repository', async (_, { directory, remote }) => {
  if (!directory || !String(remote || '').trim()) throw new Error('Enter a repository URL')
  const remoteUrl = String(remote).trim()
  sendOperationLog(`Checking out ${remoteUrl} into ${directory}`)
  try {
    await ensureGitRepository(directory)
    sendOperationLog('The destination is already a Git repository; reconnecting the remote')
    const existingRemote = await runGit(directory, ['remote', 'get-url', 'origin'], 30000).catch(() => '')
    if (!existingRemote) await runGit(directory, ['remote', 'add', 'origin', remoteUrl], 30000)
    await runGit(directory, ['fetch', 'origin'], 120000)
    await runGit(directory, ['remote', 'set-head', 'origin', '-a'], 30000).catch(() => '')
    const remoteHead = await runGit(directory, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 30000).catch(() => '')
    if (remoteHead.startsWith('origin/')) await runGit(directory, ['checkout', '-B', remoteHead.slice('origin/'.length), remoteHead], 30000)
  } catch (existingRepositoryError) {
    sendOperationLog('Destination is not a usable repository; running git clone')
    await new Promise((resolve, reject) => execFile('git', ['clone', remoteUrl, directory], { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (stdout.trim()) sendOperationLog(stdout.trim())
      if (error) { if (stderr.trim()) sendOperationLog(stderr.trim()); return reject(new Error(stderr.trim() || stdout.trim() || error.message)) }
      resolve(stdout.trim())
    }))
  }
  await startWatching(directory)
  sendOperationLog('Checkout completed and watcher started')
  return { ok: true }
})
ipcMain.handle('git-changes', () => currentDirectory ? gitChanges(currentDirectory) : [])
ipcMain.handle('get-settings', () => aiSettings)
ipcMain.handle('get-app-version', () => app.getVersion())
ipcMain.handle('get-latest-release', async () => { try { return await fetchLatestRelease() } catch (error) { console.error('[Update] release check failed', error.message); throw error } })
ipcMain.handle('open-release', (_, url) => { if (typeof url === 'string' && /^https:\/\/github\.com\//.test(url)) return shell.openExternal(url); return false })
ipcMain.handle('save-settings', (_, settings) => saveSettings(settings))
ipcMain.handle('fetch-models', async (_, endpoint) => { const data = await requestJson(`${String(endpoint).replace(/\/$/, '')}/api/tags`); return (data.models || []).map(model => model.name).filter(Boolean) })
ipcMain.handle('generate-commit-message', async (_, { files, operation = 'commit' } = {}) => {
  if (!currentDirectory) throw new Error('No directory selected')
  if (!aiSettings?.endpoint || !aiSettings?.model) throw new Error('Configure the Ollama endpoint and model in Settings')
  const selected = Array.isArray(files) ? files.filter(file => typeof file === 'string' && file && !file.includes('..')) : []
  if (!selected.length) throw new Error('Select at least one file')
  const diff = await new Promise((resolve, reject) => execFile('git', ['-C', currentDirectory, 'diff', 'HEAD', '--', ...selected], { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)))
  const untracked = await new Promise(resolve => execFile('git', ['-C', currentDirectory, 'ls-files', '--others', '--exclude-standard', '--', ...selected], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (_, stdout) => resolve(stdout.split(/\r?\n/).filter(Boolean))))
  const untrackedDiff = untracked.map(file => {
    try {
      const absolute = path.resolve(currentDirectory, file)
      const content = fs.readFileSync(absolute, 'utf8').slice(0, 2 * 1024 * 1024)
      return `\n--- /dev/null\n+++ b/${file}\n@@ new file @\n+${content.replace(/\r?\n/g, '\n+')}\n`
    } catch { return `\n--- /dev/null\n+++ b/${file}\n[new binary or unreadable file]\n` }
  }).join('')
  const completeDiff = `${diff}${untrackedDiff}`
  if (!completeDiff.trim()) throw new Error('No diff available for the selected files')
  const prompt = operation === 'stash' ? `TASK: Write exactly one Conventional Commits-style message for a work-in-progress stash.
MANDATORY LANGUAGE: ${aiSettings.language}. The description MUST be written entirely in ${aiSettings.language}; do not use Italian or another language unless ${aiSettings.language} is Italian.
FORMAT: <type>(<scope>): <description>
ALLOWED TYPES: wip, feat, fix, refactor, chore, docs, test
OUTPUT RULES: Return one line only. No markdown, quotes, translation, explanation, prefix or suffix.

DIFF:
${completeDiff}` : `TASK: Write exactly one Conventional Commits message.
MANDATORY LANGUAGE: ${aiSettings.language}. The description MUST be written entirely in ${aiSettings.language}; do not use Italian or another language unless ${aiSettings.language} is Italian.
FORMAT: <type>(<scope>): <description>
ALLOWED TYPES: feat, fix, refactor, chore, docs, test
OUTPUT RULES: Return one line only. No markdown, quotes, translation, explanation, prefix or suffix.

DIFF:
${completeDiff}`
  const result = await requestJson(`${aiSettings.endpoint}/api/generate`, { method: 'POST' }, { model: aiSettings.model, prompt, stream: false })
  const message = String(result.response || '').trim().split(/\r?\n/)[0].replace(/^['"`]+|['"`]+$/g, '').trim()
  if (!message) throw new Error('Ollama returned an empty commit message. Check the selected model and try again.')
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
ipcMain.handle('stash-selected', async (_, { files, message }) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const selected = Array.isArray(files) ? files.filter(file => typeof file === 'string' && file && !file.includes('..')) : []
  const stashMessage = String(message || '').trim()
  if (!selected.length) throw new Error('Select at least one file')
  if (!stashMessage) throw new Error('The stash message is empty')
  const result = await new Promise((resolve, reject) => execFile('git', ['-C', currentDirectory, 'stash', 'push', '-u', '-m', stashMessage, '--', ...selected], { windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || stdout.trim() || error.message)) : resolve(stdout.trim())))
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
  sendOperationLog(`PS ${currentDirectory}> ${value}`)
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', value], { cwd: currentDirectory, windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024 }, async (error, stdout, stderr) => {
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
  terminalProcess = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: directory,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    useConpty: true,
  })
  terminalProcess.onData(data => { if (win && !win.isDestroyed()) win.webContents.send('terminal-data', data) })
  terminalProcess.onExit(({ exitCode }) => { if (win && !win.isDestroyed()) win.webContents.send('terminal-exit', exitCode); terminalProcess = null })
  return { ok: true }
})
ipcMain.handle('write-terminal', (_, data) => { if (terminalProcess && typeof data === 'string') terminalProcess.write(data); return true })
ipcMain.handle('resize-terminal', (_, { cols, rows } = {}) => { if (terminalProcess) terminalProcess.resize(Math.max(20, Number(cols) || 120), Math.max(5, Number(rows) || 30)); return true })
ipcMain.handle('stop-terminal', () => { stopTerminal(); return true })
ipcMain.handle('commit-selected', async (_, { files, message, amend = false }) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const selected = Array.isArray(files) ? files.filter(file => typeof file === 'string' && file && !file.includes('..')) : []
  const commitMessage = String(message || '').trim()
  if (!selected.length) throw new Error('Select at least one file')
  if (!commitMessage) throw new Error('The commit message is empty')
  await new Promise((resolve, reject) => execFile('git', ['-C', currentDirectory, 'add', '--', ...selected], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)))
  const output = await new Promise((resolve, reject) => execFile('git', ['-C', currentDirectory, 'commit', ...(amend ? ['--amend'] : []), '-m', commitMessage], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim())))
  await publish('post-commit')
  return { ok: true, output: String(output || '') }
})
ipcMain.handle('refresh', async () => publish('post-commit'))
async function runGitRemote(command) {
  if (!currentDirectory) throw new Error('No directory selected')
  sendOperationLog(`${command === 'pull' ? 'Pull' : 'Push'} started`)
  return new Promise((resolve, reject) => execFile('git', ['-C', currentDirectory, command], { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (stdout.trim()) sendOperationLog(stdout.trim())
    if (error) { if (stderr.trim()) sendOperationLog(stderr.trim()); return reject(new Error(stderr.trim() || stdout.trim() || error.message)) }
    sendOperationLog(`${command === 'pull' ? 'Pull' : 'Push'} completed`)
    resolve(stdout.trim() || `${command} completed`)
  }))
}
ipcMain.handle('git-pull', async () => { const result = await runGitRemote('pull'); await publish('git-pull'); return result })
ipcMain.handle('git-push', async () => { const result = await runGitRemote('push'); await publish('git-push'); return result })
ipcMain.handle('get-branches', async () => {
  if (!currentDirectory) return { current: '', local: [], remote: [] }
  const [localOutput, remoteOutput] = await Promise.all([
    runGit(currentDirectory, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    runGit(currentDirectory, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
  ])
  const local = localOutput.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  const remote = remoteOutput.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.endsWith('/HEAD'))
  return { current: await gitCurrentBranch(currentDirectory), local, remote }
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
  if (!aiSettings?.endpoint || !aiSettings?.model) throw new Error('Configure the Ollama endpoint and model in Settings')
  const selected = Array.isArray(refs) ? refs.filter(ref => typeof ref === 'string') : []
  const list = await runGit(currentDirectory, ['stash', 'list', '--format=%gd|%s'])
  const messages = list.split(/\r?\n/).filter(Boolean).filter(line => selected.includes(line.split('|')[0])).map(line => line.split('|').slice(1).join('|'))
  const prompt = `TASK: Write exactly one Conventional Commits-style message that summarizes these merged work-in-progress stashes.
MANDATORY LANGUAGE: ${aiSettings.language}. The description MUST be written entirely in ${aiSettings.language}.
FORMAT: wip(<scope>): <description>
OUTPUT RULES: Return one line only. No markdown, quotes, explanation, prefix or suffix.

STASH MESSAGES:
${messages.join('\n')}`
  const result = await requestJson(`${aiSettings.endpoint}/api/generate`, { method: 'POST' }, { model: aiSettings.model, prompt, stream: false })
  const message = String(result.response || '').trim().split(/\r?\n/)[0].replace(/^['"`]+|['"`]+$/g, '').trim()
  if (!message) throw new Error('Ollama returned an empty stash merge message.')
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
  const patterns = trackOutput.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('Listing tracked patterns')).map(line => line.trim().split(/\s+/)[0]).filter(Boolean)
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
