const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('directoryAPI', {
  chooseDirectory: () => ipcRenderer.invoke('choose-directory'),
  chooseProjectIcon: () => ipcRenderer.invoke('choose-project-icon'),
  getProjectIcon: (directory) => ipcRenderer.invoke('get-project-icon', directory),
  startWatching: (directory) => ipcRenderer.invoke('start-watching', directory),
  stopWatching: () => ipcRenderer.invoke('stop-watching'),
  gitChanges: () => ipcRenderer.invoke('git-changes'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  fetchModels: (endpoint) => ipcRenderer.invoke('fetch-models', endpoint),
  generateCommitMessage: (files) => ipcRenderer.invoke('generate-commit-message', files),
  getDiff: (file) => ipcRenderer.invoke('get-diff', file),
  getStashes: () => ipcRenderer.invoke('get-stashes'),
  stashSelected: (files, message) => ipcRenderer.invoke('stash-selected', { files, message }),
  openInExplorer: () => ipcRenderer.invoke('open-in-explorer'),
  commitSelected: (files, message) => ipcRenderer.invoke('commit-selected', { files, message }),
  refresh: () => ipcRenderer.invoke('refresh'),
  gitPull: () => ipcRenderer.invoke('git-pull'),
  gitPush: () => ipcRenderer.invoke('git-push'),
  getProjects: () => ipcRenderer.invoke('get-projects'),
  addProject: (project) => ipcRenderer.invoke('add-project', project),
  updateProject: (originalPath, project) => ipcRenderer.invoke('update-project', originalPath, project),
  removeProject: (directory) => ipcRenderer.invoke('remove-project', directory),
  onOpenSettings: (callback) => { ipcRenderer.on('open-settings', callback) },
  onUpdate: (callback) => { ipcRenderer.on('directory-update', (_, data) => callback(data)) }
})
