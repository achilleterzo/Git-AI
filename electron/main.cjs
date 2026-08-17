const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } = require('electron')
const { execFile } = require('child_process')
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

const PUBLISH_DEBOUNCE_MS = 200

function windowStatePath() { return path.join(app.getPath('userData'), 'window-state.json') }
function settingsPath() { return path.join(app.getPath('userData'), 'settings.json') }
function projectsPath() { return path.join(app.getPath('userData'), 'projects.json') }
function loadProjects() { try { return JSON.parse(fs.readFileSync(projectsPath(), 'utf8')).map(project => typeof project === 'string' ? { path: project, icon: findProjectIcon(project) } : project).filter(project => project?.path && fs.existsSync(project.path)) } catch { return [] } }
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
function gitPushPending(directory) {
  return new Promise(resolve => execFile('git', ['-C', directory, 'rev-list', '--count', '@{u}..HEAD'], { windowsHide: true, timeout: 10000 }, (error, stdout) => resolve(!error && Number.parseInt(stdout.trim(), 10) > 0)))
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

async function publish(reason = 'refresh', generation = watchGeneration) {
  if (!currentDirectory || generation !== watchGeneration) return
  if (publishRunning) { publishQueued = true; return }

  publishRunning = true
  const directory = currentDirectory
  try {
    const results = await Promise.allSettled([shellSnapshot(directory), gitChanges(directory), gitPushPending(directory)])
    const files = results[0].status === 'fulfilled' ? results[0].value : []
    const changes = results[1].status === 'fulfilled' ? results[1].value : []
    const scanError = results[0].status === 'rejected' ? `File scan: ${results[0].reason.message}` : null
    const gitError = results[1].status === 'rejected' ? `Git: ${results[1].reason.message}` : null
    if (directory === currentDirectory && generation === watchGeneration) {
      win.webContents.send('directory-update', { directory, projectIcon: findProjectIcon(directory), files, changes, pushPending: results[2].status === 'fulfilled' && results[2].value, gitOk: results[1].status === 'fulfilled', reason, error: [scanError, gitError].filter(Boolean).join(' | ') || null, at: new Date().toISOString() })
    }
  } catch (error) {
    if (directory === currentDirectory && generation === watchGeneration) win.webContents.send('directory-update', { error: error.message })
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
  if (watcher) watcher.close()
  if (publishTimer) { clearTimeout(publishTimer); publishTimer = null }
  watchGeneration += 1
  publishQueued = false
  currentDirectory = directory
  const generation = watchGeneration
  watcher = fs.watch(directory, { recursive: true }, (_, filename) => {
    if (generation === watchGeneration) schedulePublish(filename ? String(filename) : 'change')
  })
  await publish('started', generation)
}
function openDirectory() { dialog.showOpenDialog(win, { properties: ['openDirectory'] }).then(result => { if (result.filePaths[0]) startWatching(result.filePaths[0]) }) }
function buildMenu() { Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'File', submenu: [{ label: 'Open directory…', accelerator: 'CmdOrCtrl+O', click: openDirectory }, { label: 'Refresh Git status', accelerator: 'CmdOrCtrl+R', click: () => publish('manual-refresh') }, { type: 'separator' }, { label: 'Settings…', click: () => win.webContents.send('open-settings') }, { type: 'separator' }, { role: 'quit' }] }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggledevtools' }] }])) }

ipcMain.handle('choose-directory', async () => (await dialog.showOpenDialog(win, { properties: ['openDirectory'] })).filePaths[0] || null)
ipcMain.handle('start-watching', async (_, directory) => { await startWatching(directory); return { ok: true } })
ipcMain.handle('git-changes', () => currentDirectory ? gitChanges(currentDirectory) : [])
ipcMain.handle('get-settings', () => aiSettings)
ipcMain.handle('save-settings', (_, settings) => saveSettings(settings))
ipcMain.handle('fetch-models', async (_, endpoint) => { const data = await requestJson(`${String(endpoint).replace(/\/$/, '')}/api/tags`); return (data.models || []).map(model => model.name).filter(Boolean) })
ipcMain.handle('generate-commit-message', async (_, files) => {
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
  const prompt = `TASK: Write exactly one Conventional Commits message.
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
  return new Promise((resolve, reject) => execFile('git', ['-C', currentDirectory, 'stash', 'push', '-u', '-m', stashMessage, '--', ...selected], { windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || stdout.trim() || error.message)) : resolve(stdout.trim())))
})
ipcMain.handle('open-in-explorer', async () => {
  if (!currentDirectory) throw new Error('No directory selected')
  const error = await shell.openPath(currentDirectory)
  if (error) throw new Error(error)
  return { ok: true }
})
ipcMain.handle('commit-selected', async (_, { files, message }) => {
  if (!currentDirectory) throw new Error('No directory selected')
  const selected = Array.isArray(files) ? files.filter(file => typeof file === 'string' && file && !file.includes('..')) : []
  const commitMessage = String(message || '').trim()
  if (!selected.length) throw new Error('Select at least one file')
  if (!commitMessage) throw new Error('The commit message is empty')
  await new Promise((resolve, reject) => execFile('git', ['-C', currentDirectory, 'add', '--', ...selected], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)))
  return new Promise((resolve, reject) => execFile('git', ['-C', currentDirectory, 'commit', '-m', commitMessage], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim())))
})
ipcMain.handle('refresh', async () => { await publish('post-commit'); return { ok: true } })
async function runGitRemote(command) {
  if (!currentDirectory) throw new Error('No directory selected')
  return new Promise((resolve, reject) => execFile('git', ['-C', currentDirectory, command], { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || stdout.trim() || error.message)) : resolve(stdout.trim() || `${command} completed`)))
}
ipcMain.handle('git-pull', async () => { const result = await runGitRemote('pull'); await publish('git-pull'); return result })
ipcMain.handle('git-push', async () => { const result = await runGitRemote('push'); await publish('git-push'); return result })
ipcMain.handle('get-projects', () => projects)
ipcMain.handle('add-project', (_, directory) => { if (!projects.some(project => project.path === directory)) { projects.unshift({ path: directory, icon: findProjectIcon(directory) }); persistProjects() } return projects })
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

app.whenReady().then(() => { aiSettings = loadSettings(); projects = loadProjects(); createWindow(); buildMenu() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
