const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('directoryAPI', {
  chooseDirectory: () => ipcRenderer.invoke('choose-directory'),
  startWatching: (directory) => ipcRenderer.invoke('start-watching', directory),
  stopWatching: () => ipcRenderer.invoke('stop-watching'),
  gitChanges: () => ipcRenderer.invoke('git-changes'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  fetchModels: (endpoint) => ipcRenderer.invoke('fetch-models', endpoint),
  generateCommitMessage: (files) => ipcRenderer.invoke('generate-commit-message', files),
  commitSelected: (files, message) => ipcRenderer.invoke('commit-selected', { files, message }),
  refresh: () => ipcRenderer.invoke('refresh'),
  gitPull: () => ipcRenderer.invoke('git-pull'),
  gitPush: () => ipcRenderer.invoke('git-push'),
  getProjects: () => ipcRenderer.invoke('get-projects'),
  addProject: (directory) => ipcRenderer.invoke('add-project', directory),
  removeProject: (directory) => ipcRenderer.invoke('remove-project', directory),
  onOpenSettings: (callback) => ipcRenderer.on('open-settings', callback),
  onUpdate: (callback) => ipcRenderer.on('directory-update', (_, data) => callback(data))
})
