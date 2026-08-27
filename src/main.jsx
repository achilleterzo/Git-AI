import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import packageJson from '../package.json'
import appIcon from '../assets/pulse-git-ai.png'
import ChangesPage from './pages/ChangesPage'
import StashPage from './pages/StashPage'
import WatchingPill from './components/WatchingPill'
import LfsPill from './components/LfsPill'
import LfsPage from './pages/LfsPage'
import HistoryPage from './pages/HistoryPage'
import HomePage from './pages/HomePage'
import TerminalConsole from './components/TerminalConsole'
import ConfirmationModal from './components/ConfirmationModal'
import SettingsModal from './components/SettingsModal'
import './styles.css'

const defaultPathIcon = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Cpath fill="%235eead4" d="M3 5.5A2.5 2.5 0 0 1 5.5 3h5l2 2H18a3 3 0 0 1 3 3v1H3v-3.5Zm0 5.5h18v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-7Z"/%3E%3C/svg%3E'
const normalizeProjects = list => (Array.isArray(list) ? list : []).map(project => typeof project === 'string' ? { path: project, icon: null } : project).filter(project => typeof project?.path === 'string' && project.path)
const projectName = project => { const directory = typeof project?.path === 'string' ? project.path : ''; return project?.name || directory.split(/[\\/]/).filter(Boolean).at(-1) || directory || 'Unnamed project' }
const compareVersions = (left, right) => { const a = String(left || '').split('.').map(Number); const b = String(right || '').split('.').map(Number); for (let index = 0; index < 3; index += 1) { const difference = (a[index] || 0) - (b[index] || 0); if (difference) return difference } return 0 }

const formatSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
const cappedCount = count => Number(count) > 999 ? '+999' : String(Number(count) || 0)
const OPERATION_TIMEOUT_MS = 180000

function App() {
  const [directory, setDirectory] = useState('')
  const [fileIndexing, setFileIndexing] = useState({ status: 'idle', error: null })
  const [changes, setChanges] = useState([])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(false)
  const [starting, setStarting] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [expanded, setExpanded] = useState(new Set(['']))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantPrompt, setAssistantPrompt] = useState('')
  const [assistantPlan, setAssistantPlan] = useState(null)
  const [assistantBusy, setAssistantBusy] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [appVersion, setAppVersion] = useState(packageJson.version)
  const [updateRelease, setUpdateRelease] = useState(null)
  const [updateNoticeVisible, setUpdateNoticeVisible] = useState(false)
  const [projectModal, setProjectModal] = useState(false)
  const [projectDraft, setProjectDraft] = useState({ path: '', name: '', icon: null })
  const [projectEditingPath, setProjectEditingPath] = useState('')
  const [lfsToggleConfirmation, setLfsToggleConfirmation] = useState(null)
  const [emptyDirectory, setEmptyDirectory] = useState('')
  const [checkoutRemote, setCheckoutRemote] = useState('')
  const [settings, setSettings] = useState({ aiEnabled: false, endpoint: 'http://localhost:11434', model: '', language: 'English', reasoning: 'instant' })
  const [models, setModels] = useState([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMessage, setAiMessage] = useState('')
  const [aiError, setAiError] = useState('')
  const [projects, setProjects] = useState([])
  const [gitBusy, setGitBusy] = useState(false)
  const [incomingCommits, setIncomingCommits] = useState(0)
  const [outgoingCommits, setOutgoingCommits] = useState(0)
  const [hasCommits, setHasCommits] = useState(false)
  const [currentBranch, setCurrentBranch] = useState('')
  const [gitLfs, setGitLfs] = useState(false)
  const [branchSwitchRequest, setBranchSwitchRequest] = useState(null)
  const [pushConfirmation, setPushConfirmation] = useState(false)
  const [revertConfirmation, setRevertConfirmation] = useState(false)
  const [deleteStashConfirmation, setDeleteStashConfirmation] = useState(false)
  const [errorModal, setErrorModal] = useState('')
  const [diffModal, setDiffModal] = useState(null)
  const [view, setView] = useState('home')
  const [stashes, setStashes] = useState([])
  const [pendingCommitCount, setPendingCommitCount] = useState(0)
  const [selectedStashes, setSelectedStashes] = useState([])
  const [expandedStashRef, setExpandedStashRef] = useState('')
  const [loading, setLoading] = useState('')
  const [operationProgress, setOperationProgress] = useState(null)
  const [operationPhase, setOperationPhase] = useState('')
  const [consoleLines, setConsoleLines] = useState([])
  const [aiPromptLog, setAiPromptLog] = useState(null)
  const [consoleTab, setConsoleTab] = useState('ai')
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleCommand, setConsoleCommand] = useState('')
  const [projectIcon, setProjectIcon] = useState(null)
  const [pendingOperation, setPendingOperation] = useState('commit')
  const [lastEvent, setLastEvent] = useState('Waiting for a directory')
  const operationRef = useRef({ id: 0, timer: null })
  const progressHandlerRef = useRef(null)
  const visibleChanges = useMemo(() => changes.filter(c => c.file.toLowerCase().includes(query.toLowerCase())), [changes, query])
  const allPaths = visibleChanges.map(change => change.file)
  const allSelected = allPaths.length > 0 && allPaths.every(path => selected.has(path))
  const allPartial = allPaths.some(path => selected.has(path)) && !allSelected
  async function runShellCommand(event) { event.preventDefault(); const command = consoleCommand.trim(); if (!command || !directory) return; setConsoleCommand(''); try { await window.directoryAPI.runShellCommand(command) } catch (error) { setConsoleLines(lines => [...lines, { at: new Date().toISOString(), message: `Error: ${error.message}` }].slice(-300)) } }
  async function generateAssistantPlan() { if (!directory || !assistantPrompt.trim()) return; setAssistantBusy(true); setAssistantPlan(null); try { setAssistantPlan(await window.directoryAPI.generateProjectPlan(assistantPrompt)) } catch (error) { setErrorModal(error.message) } finally { setAssistantBusy(false) } }
  async function applyAssistantPlan() { if (!assistantPlan?.changes?.length) return; setAssistantBusy(true); try { await window.directoryAPI.applyProjectPlan(assistantPlan.changes); setAssistantOpen(false); setAssistantPlan(null); setAssistantPrompt('') } catch (error) { setErrorModal(error.message) } finally { setAssistantBusy(false) } }
  async function copyConsoleContent(kind) { const content = kind === 'request' ? (aiPromptLog ? JSON.stringify(aiPromptLog, null, 2) : 'No AI request recorded yet.') : (consoleLines.length ? consoleLines.map(line => `[${line.at ? new Date(line.at).toLocaleTimeString() : '--:--:--'}] ${line.message}`).join('\n') : 'No service log entries yet.'); try { await navigator.clipboard.writeText(content) } catch { setConsoleLines(lines => [...lines, { at: new Date().toISOString(), message: 'Could not copy console content.' }].slice(-300)) } }

  useEffect(() => { window.directoryAPI.getSettings().then(setSettings); window.directoryAPI.getAppVersion().then(version => { setAppVersion(version); window.directoryAPI.getLatestRelease().then(release => { if (release?.version && compareVersions(release.version, version) > 0) setUpdateRelease(release) }).catch(() => {}) }).catch(() => {}); window.directoryAPI.getProjects().then(async result => { const savedProjects = normalizeProjects(result); setProjects(savedProjects); const lastProject = savedProjects.slice().sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))[0]; if (lastProject?.lastOpened) await runOperation('Restoring project…', () => openSelectedDirectory(lastProject.path, lastProject)); else setView('home') }).catch(error => { setView('home'); setErrorModal(String(error?.message || error)) }); window.directoryAPI.onOpenSettings(() => setSettingsOpen(true)); window.directoryAPI.onOpenAbout(() => setAboutOpen(true)); window.directoryAPI.onOpenProjectAssistant(() => { setAssistantPlan(null); setAssistantOpen(true) }); return undefined }, [])
  useEffect(() => { window.directoryAPI.onOperationLog(data => setConsoleLines(lines => [...lines, { ...data, message: String(data?.message || '') }].slice(-300))); return undefined }, [])
  useEffect(() => { window.directoryAPI.onAiPrompt(data => setAiPromptLog(data)); return undefined }, [])
  useEffect(() => { window.directoryAPI.onOperationProgress(data => { if (progressHandlerRef.current) progressHandlerRef.current(data) }); return undefined }, [])
  useEffect(() => { window.directoryAPI.onFileIndexUpdate(data => { setFileIndexing({ status: String(data.status || 'idle'), error: data.error || null, updatedAt: data.updatedAt || null }) }); return undefined }, [])
  useEffect(() => { window.directoryAPI.onUpdate(data => {
    if (data.indexing) setFileIndexing(current => ({ ...current, status: String(data.indexing) }))
    setChanges(data.changes || [])
    setIncomingCommits(Number(data.incomingCommits) || 0)
    setOutgoingCommits(Number(data.outgoingCommits) || 0)
    setHasCommits(Boolean(data.hasCommits))
    setCurrentBranch(String(data.branch || '').trim())
    setGitLfs(Boolean(data.gitLfs))
    if (data.directory) setProjects(value => value.map(project => project.path === data.directory ? { ...project, gitLfs: Boolean(data.gitLfs), icon: data.projectIcon || project.icon } : project))
    if (data.reason === 'directory-removed') {
      setActive(false)
      setProjects(value => value.filter(project => project.path !== data.removedDirectory))
      setView('home')
    }
    setDirectory(data.directory || '')
    setProjectIcon(data.projectIcon || projects.find(project => project.path === data.directory)?.icon || null)
    setActive(true)
    setStarting(false)
    if (data.gitOk) setSelected(previous => {
      const currentPaths = new Set((data.changes || []).map(change => change.file))
      return new Set([...previous].filter(path => currentPaths.has(path)))
    })
    if (data.error) setErrorModal(data.error)
    else if (['git-pull', 'git-push', 'post-commit'].includes(data.reason)) setLastEvent(data.reason === 'post-commit' ? 'Commit completed' : data.reason === 'git-push' ? 'Push completed' : 'Pull completed')
  }) }, [])
  useEffect(() => { if (view === 'stash' && directory) window.directoryAPI.getStashes().then(setStashes).catch(error => setErrorModal(error.message)) }, [view, directory, active])
  useEffect(() => { if (directory) window.directoryAPI.getPendingCommits().then(commits => setPendingCommitCount(Array.isArray(commits) ? commits.length : 0)).catch(() => setPendingCommitCount(0)) }, [directory, active, view])
  useEffect(() => { if (view === 'lfs' && !gitLfs) setView('changes') }, [view, gitLfs])
  useEffect(() => { if (projectModal && projectDraft.path) window.directoryAPI.getProjectIcon(projectDraft.path).then(icon => setProjectDraft(value => value.path === projectDraft.path && !value.icon ? { ...value, icon } : value)).catch(() => {}) }, [projectModal, projectDraft.path])
  useEffect(() => { if (!updateRelease) return undefined; setUpdateNoticeVisible(true); const timer = setTimeout(() => setUpdateNoticeVisible(false), 9000); return () => clearTimeout(timer) }, [updateRelease])
  async function choose() { setProjectEditingPath(''); setProjectDraft({ path: '', name: '', icon: null, gitLfs: false }); setProjectModal(true) }
  async function browseProjectPath() { const selected = await window.directoryAPI.chooseDirectory(projectDraft.path); if (selected) { const icon = await window.directoryAPI.getProjectIcon(selected); setProjectDraft(value => ({ ...value, path: selected, name: value.name || projectName({ path: selected }), icon })) } }
  async function browseProjectIcon() { try { const icon = await window.directoryAPI.chooseProjectIcon(projectDraft.path); if (icon) setProjectDraft(value => ({ ...value, icon })) } catch (error) { setErrorModal(error.message) } }
  async function editProject(project) { setProjectEditingPath(project.path); setProjectDraft({ path: project.path, name: project.name || projectName(project), icon: project.icon || null, gitLfs: project.gitLfs === true }); setProjectModal(true) }
  async function confirmLfsToggle() { const request = lfsToggleConfirmation; setLfsToggleConfirmation(null); if (!request) return; try { await runOperation(request.enabled ? 'Enabling Git LFS…' : 'Disabling Git LFS…', () => window.directoryAPI.setLfsEnabled(request.directory, request.enabled)); setProjectDraft(value => value.path === request.directory ? { ...value, gitLfs: request.enabled } : value); setProjects(value => value.map(project => project.path === request.directory ? { ...project, gitLfs: request.enabled } : project)); if (directory === request.directory) setGitLfs(request.enabled) } catch (error) { setErrorModal(String(error?.message || error)) } }
  function closeOperation(id) { if (operationRef.current.id !== id) return; if (operationRef.current.timer) clearTimeout(operationRef.current.timer); operationRef.current = { id, timer: null }; progressHandlerRef.current = null; setLoading(''); setOperationProgress(null); setOperationPhase('') }
  // Restarted on every progress tick, so a long clone is not mistaken for a stuck dialog.
  function armOperationWatchdog(id, label) {
    if (operationRef.current.id !== id) return
    if (operationRef.current.timer) clearTimeout(operationRef.current.timer)
    operationRef.current.timer = setTimeout(() => {
      closeOperation(id)
      setErrorModal(`${label.replace(/…$/, '')} has not reported progress for ${Math.round(OPERATION_TIMEOUT_MS / 1000)}s and is still running in the background. Check the operation console for details.`)
    }, OPERATION_TIMEOUT_MS)
  }
  async function runOperation(label, task, { trackProgress = false } = {}) {
    if (operationRef.current.timer) clearTimeout(operationRef.current.timer)
    const id = operationRef.current.id + 1
    operationRef.current = { id, timer: null }
    setLoading(label)
    setOperationProgress(null)
    setOperationPhase('')
    progressHandlerRef.current = trackProgress ? data => {
      if (operationRef.current.id !== id) return
      const percent = Number(data?.percent)
      if (!Number.isFinite(percent)) return
      setOperationProgress(Math.max(0, Math.min(100, Math.round(percent))))
      setOperationPhase(String(data?.phase || ''))
      armOperationWatchdog(id, label)
    } : null
    armOperationWatchdog(id, label)
    try { return await task() } finally { closeOperation(id) }
  }
  async function openSelectedDirectory(path, project) { const metadata = project || { path }; const targetView = view === 'home' ? 'changes' : view; const previousView = view; setDirectory(path); setProjectIcon(metadata.icon || null); setFileIndexing({ status: 'idle', error: null }); setCurrentBranch(''); setIncomingCommits(0); setOutgoingCommits(0); setGitLfs(Boolean(metadata.gitLfs)); setActive(false); setStarting(true); setChanges([]); setSelected(new Set()); setStashes([]); setEmptyDirectory(''); setCheckoutRemote(''); setView(targetView); try { const watchResult = await window.directoryAPI.startWatching(path); if (watchResult?.ok === false && watchResult.code === 'NOT_A_GIT_REPOSITORY') { setProjects(normalizeProjects(await window.directoryAPI.addProject(metadata))); setActive(false); setStarting(false); setEmptyDirectory(path); setProjectModal(false); return false } setProjects(normalizeProjects(await window.directoryAPI.addProject(metadata))); return true } catch (error) { const message = String(error?.message || error || ''); setStarting(false); setView(previousView); setErrorModal(message); return false } }
  async function saveProject() { if (!projectDraft.path) return; const editing = Boolean(projectEditingPath); const project = { ...projectDraft, name: projectDraft.name.trim() || projectName({ path: projectDraft.path }), ...(editing ? {} : { lastOpened: Date.now() }) }; try { await runOperation(editing ? 'Saving project…' : 'Loading project…', async () => { if (editing) { if (projectEditingPath !== projectDraft.path) { await window.directoryAPI.removeProject(projectEditingPath); setProjects(normalizeProjects(await window.directoryAPI.addProject(project))) } else setProjects(normalizeProjects(await window.directoryAPI.updateProject(projectEditingPath, project))); setProjectModal(false) } else if (await openSelectedDirectory(projectDraft.path, project)) setProjectModal(false); setProjectEditingPath('') }) } catch (error) { setErrorModal(String(error?.message || error)) } }
  async function selectProject(option) { if (!option?.value) return; try { await openSelectedDirectory(option.value, { path: option.value, lastOpened: Date.now() }) } catch (error) { setStarting(false); setErrorModal(String(error?.message || error)) } }
  async function initializeEmptyDirectory() { try { await runOperation('Initializing Git…', async () => { await window.directoryAPI.initializeRepository(emptyDirectory); setProjects(normalizeProjects(await window.directoryAPI.addProject({ path: emptyDirectory, lastOpened: Date.now() }))); setEmptyDirectory(''); setView('changes') }) } catch (error) { setErrorModal(String(error?.message || error)) } }
  async function checkoutEmptyDirectory() { try { await runOperation('Checking out repository…', async () => { await window.directoryAPI.checkoutRepository(emptyDirectory, checkoutRemote); setProjects(normalizeProjects(await window.directoryAPI.addProject({ path: emptyDirectory, lastOpened: Date.now() }))); setEmptyDirectory(''); setView('changes') }, { trackProgress: true }) } catch (error) { setErrorModal(String(error?.message || error)) } }
  async function openHomeProject(project) { setView('changes'); await selectProject({ value: project.path }) }
  async function removeProjectOption(option) { if (!option || !window.confirm(`Remove "${option.value}" from the project list?\nNo files will be deleted.`)) return; try { const isCurrent = directory === option.value || emptyDirectory === option.value; if (directory === option.value) await window.directoryAPI.stopWatching(); setProjects(normalizeProjects(await window.directoryAPI.removeProject(option.value))); if (isCurrent) { setDirectory(''); setActive(false); setChanges([]); setGitLfs(false); setEmptyDirectory(''); setSelected(new Set()); setView('home') } } catch (error) { setErrorModal(error.message) } }
  async function resume() { if (!directory) return; setStarting(true); try { const watchResult = await window.directoryAPI.startWatching(directory); if (watchResult?.ok === false && watchResult.code === 'NOT_A_GIT_REPOSITORY') { setActive(false); setStarting(false); setEmptyDirectory(directory) } } catch (error) { setStarting(false); setErrorModal(String(error?.message || error)) } }
  async function stop() { await window.directoryAPI.stopWatching(); setActive(false); setStarting(false); setChanges([]); setSelected(new Set()); setLastEvent('Monitor stopped') }
  function toggleFolder(path) { setExpanded(value => { const next = new Set(value); next.has(path) ? next.delete(path) : next.add(path); return next }) }
  function expandAllFolders() { setExpanded(value => new Set([...value, ...changes.flatMap(change => { const parts = change.file.replaceAll('\\', '/').split('/').filter(Boolean); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/')) })])) }
  function collapseAllFolders() { setExpanded(new Set()) }
  async function refreshPendingCommitCount() { try { const commits = await window.directoryAPI.getPendingCommits(); setPendingCommitCount(Array.isArray(commits) ? commits.length : 0) } catch { setPendingCommitCount(0) } }
  function toggleSelection(paths) { setSelected(value => { const next = new Set(value); const all = paths.every(path => next.has(path)); paths.forEach(path => all ? next.delete(path) : next.add(path)); return next }) }
  async function loadModels(endpoint = settings.endpoint) { setAiError(''); setModelsLoading(true); try { const result = await window.directoryAPI.fetchModels(endpoint); setModels(value => settings.model && !result.includes(settings.model) ? [settings.model, ...result] : result); if (!settings.model && result[0]) setSettings(value => ({ ...value, model: result[0] })); return result } catch (error) { setAiError(error.message); return null } finally { setModelsLoading(false) } }
  async function saveAiSettings() { setAiError(''); try { await window.directoryAPI.saveSettings(settings); setSettingsOpen(false) } catch (error) { setErrorModal(error.message) } }
  async function generateCommitMessage(operation = 'commit') { setPendingOperation(operation); setAiBusy(true); setAiError(''); try { setAiMessage(await runOperation(operation === 'stash' ? 'Generating stash message…' : operation === 'amend' ? 'Generating amend message…' : 'Generating commit message…', () => window.directoryAPI.generateCommitMessage([...selected], operation))) } catch (error) { setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false) } }
  async function generateStashMergeMessage() { setPendingOperation('stash-merge'); setAiBusy(true); setAiError(''); try { setAiMessage(await runOperation('Generating stash merge message…', () => window.directoryAPI.generateStashMergeMessage(selectedStashes.map(stash => stash.ref)))) } catch (error) { setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false) } }
  async function openDiff(file) { try { setDiffModal({ file, diff: await window.directoryAPI.getDiff(file) }) } catch (error) { setErrorModal(error.message) } }
  async function commitSelected() { const amend = pendingOperation === 'amend'; setAiBusy(true); setAiError(''); try { await runOperation(amend ? 'Amending commit…' : 'Creating commit…', () => window.directoryAPI.commitSelected([...selected], aiMessage, amend)); setAiMessage(''); setSelected(new Set()); setLastEvent(amend ? 'Commit amended' : 'Commit completed') } catch (error) { setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false) } }
  async function moveSelected(files) { setGitBusy(true); try { await runOperation('Preparing file move…', () => window.directoryAPI.moveSelected(files)); setSelected(new Set()); setLastEvent('File move prepared for commit') } catch (error) { setErrorModal(error.message) } finally { setGitBusy(false) } }
  async function addGitignoreEntry(kind, value) { setGitBusy(true); try { const result = await runOperation('Updating .gitignore…', () => window.directoryAPI.addGitignoreEntry(kind, value)); setLastEvent(result?.added ? `Added ${result.pattern} to .gitignore` : `${result.pattern} is already in .gitignore`) } catch (error) { setErrorModal(String(error?.message || error)) } finally { setGitBusy(false) } }
  async function addGitignoreSelection(entries) { setGitBusy(true); try { const result = await runOperation('Updating .gitignore…', () => window.directoryAPI.addGitignoreSelection(entries)); setLastEvent(`Added ${result?.added || 0} selected ignore rule${result?.added === 1 ? '' : 's'} to .gitignore`) } catch (error) { setErrorModal(String(error?.message || error)) } finally { setGitBusy(false) } }
  async function stashSelected() { setAiBusy(true); setAiError(''); try { await runOperation('Creating stash…', () => window.directoryAPI.stashSelected([...selected], aiMessage)); setAiMessage(''); setSelected(new Set()); setLastEvent('Stash created'); setStashes(await window.directoryAPI.getStashes()) } catch (error) { setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false) } }
  async function restoreStash({ partialRef = '', files = [] } = {}) { if (!selectedStashes.length && !(partialRef && files.length)) return; setGitBusy(true); try { await runOperation(files.length ? `Recovering ${files.length} stash file${files.length > 1 ? 's' : ''}…` : `Recovering ${selectedStashes.length} stash${selectedStashes.length > 1 ? 'es' : ''}…`, async () => { if (files.length && partialRef) await window.directoryAPI.unstashFiles(partialRef, files); else if (selectedStashes.length > 1) await window.directoryAPI.unstashMany(selectedStashes.map(stash => stash.ref)); else await window.directoryAPI.unstash(selectedStashes[0].ref) }); if (!files.length) setSelectedStashes([]); setStashes(await window.directoryAPI.getStashes()) } catch (error) { setErrorModal(error.message) } finally { setGitBusy(false) } }
  async function mergeStashes() { setAiBusy(true); setAiError(''); try { await runOperation('Merging stashes…', () => window.directoryAPI.mergeStashes(selectedStashes.map(stash => stash.ref), aiMessage)); setAiMessage(''); setSelectedStashes([]); setStashes(await window.directoryAPI.getStashes()) } catch (error) { setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false) } }
  function requestDeleteStash() { if (selectedStashes.length) setDeleteStashConfirmation(true) }
  async function confirmDeleteStash() { setDeleteStashConfirmation(false); setGitBusy(true); try { await runOperation(`Deleting ${selectedStashes.length} stash${selectedStashes.length > 1 ? 'es' : ''}…`, async () => { if (selectedStashes.length > 1) await window.directoryAPI.deleteStashes(selectedStashes.map(stash => stash.ref)); else await window.directoryAPI.deleteStash(selectedStashes[0].ref) }); setSelectedStashes([]); setStashes(await window.directoryAPI.getStashes()) } catch (error) { setErrorModal(error.message) } finally { setGitBusy(false) } }
  function requestRevert() { if (selected.size) setRevertConfirmation(true) }
  async function confirmRevert() { setRevertConfirmation(false); setGitBusy(true); try { await runOperation('Reverting selected files…', () => window.directoryAPI.revertFiles([...selected])); setSelected(new Set()) } catch (error) { setErrorModal(error.message) } finally { setGitBusy(false) } }
  async function requestPush() { if (!directory || gitBusy || outgoingCommits < 1) return; setPushConfirmation(true) }
  async function runGitRemote(action, confirmed = false) { if (action === 'push' && !confirmed) { if (!directory || gitBusy || outgoingCommits < 1) return; setPushConfirmation(true); return } setGitBusy(true); try { const result = await runOperation(action === 'push' ? 'Pushing changes…' : 'Pulling changes…', () => action === 'pull' ? window.directoryAPI.gitPull() : window.directoryAPI.gitPush(), { trackProgress: true }); setLastEvent(result || `${action === 'push' ? 'Push' : 'Pull'} completed`) } catch (error) { setErrorModal(error.message) } finally { setGitBusy(false) } }
  async function handleBranchSwitch(request) { if (request?.error) { setErrorModal(request.error); return } if (request?.remoteConnected) { await window.directoryAPI.refresh(); return } if (changes.length > 0) { setBranchSwitchRequest(request); return } await executeBranchSwitch(request, false) }
  async function executeBranchSwitch(request, stash) { setBranchSwitchRequest(null); try { await runOperation(stash ? 'Stashing changes and switching branch…' : 'Switching branch…', () => window.directoryAPI.switchBranch({ ...request, stash })); setSelected(new Set()) } catch (error) { setErrorModal(error.message) } }
  async function confirmPush() { setPushConfirmation(false); await runGitRemote('push', true); await refreshPendingCommitCount() }
  // File listing rendering lives in FilesTable.

  const pageProps = {
    directory,
    projects,
    choose,
    selectProject,
    removeProjectOption,
    active,
    stop,
    resume,
    defaultPathIcon,
    emptyDirectory,
    checkoutRemote,
    setCheckoutRemote,
    initializeEmptyDirectory,
    checkoutEmptyDirectory,
    currentBranch,
    gitLfs,
    onBranchSwitch: handleBranchSwitch,
    requestRevert,
    requestDeleteStash,
    generateStashMergeMessage,
    mergeStashes,
    selectedStashes,
    restoreStash,
    setSelectedStashes,
    expandedStashRef,
    setExpandedStashRef,
    incomingCommits,
    outgoingCommits,
    hasCommits,
    selected,
    aiBusy,
    gitBusy,
    generateCommitMessage,
    moveSelected,
    addGitignoreEntry,
    addGitignoreSelection,
    aiEnabled: settings.aiEnabled,
    runGitRemote,
    requestPush,
    changes,
    fileIndexing,
    query,
    setQuery,
    expanded,
    toggleFolder,
    expandAllFolders,
    collapseAllFolders,
    refreshPendingCommitCount,
    toggleSelection,
    openDiff,
  }
  function renderPage() {
    if (view === 'home') return <HomePage projects={projects} directory={directory} defaultPathIcon={defaultPathIcon} choose={choose} openHomeProject={openHomeProject} editProject={editProject} projectName={projectName} LfsPill={LfsPill} />
    const pages = {
      changes: <ChangesPage {...pageProps} />,
      stash: <StashPage {...pageProps} stashes={stashes} />,
      history: <HistoryPage {...pageProps} runOperation={runOperation} setErrorModal={setErrorModal} />,
      lfs: <LfsPage {...pageProps} loading={loading} runOperation={runOperation} setErrorModal={setErrorModal} />,
    }
    return <><header className="page-header page-header-compact"><span className="eyebrow">WORKSPACE / MONITOR</span><WatchingPill active={active} starting={starting} indexing={fileIndexing.status === 'indexing'} directory={directory} stop={stop} resume={resume} /></header>{pages[view] || pages.changes}</>
  }

  return (
    <main>
      <aside>
        <div className="brand"><span className="brand-mark">✦</span><div><strong>Pulse</strong><small>GIT AI</small></div></div>
        <div className="side-label">HOME</div>
        <div className={`nav ${view === 'home' ? 'active' : ''}`} onClick={() => setView('home')}><i className="nav-icon home-nav-icon" /><span>Home</span></div>
        <div className="side-label monitor-label">MONITOR</div>
        <div className={`nav ${view === 'changes' ? 'active' : ''}`} onClick={() => setView('changes')}><i className="nav-icon changes-nav-icon" /><span>File changes</span><b className="nav-count">{cappedCount(changes.length)}</b></div>
        <div className={`nav ${view === 'stash' ? 'active' : ''}`} onClick={() => setView('stash')}><i className="nav-icon stash-nav-icon" /><span>Stash</span><b className="nav-count">{cappedCount(stashes.length)}</b></div>
        {gitLfs && <div className={`nav ${view === 'lfs' ? 'active' : ''}`} onClick={() => setView('lfs')}><i className="nav-icon lfs-nav-icon" /><span>LFS</span></div>}
        <div className={`nav ${view === 'history' ? 'active' : ''}`} onClick={() => setView('history')}><i className="nav-icon history-nav-icon" /><span>History</span><b className="nav-count">{cappedCount(pendingCommitCount)}</b></div>
        <div className="side-footer"><div className="side-footer-info"><strong>Pulse Git AI</strong><span>v{appVersion} · ready</span></div>{updateRelease && <button className="update-pill" onClick={() => window.directoryAPI.openRelease(updateRelease.url)}>Update v{updateRelease.version}</button>}</div>
      </aside>

      <section className="content">
        {renderPage()}

        {updateRelease && updateNoticeVisible && <div className="update-banner"><div><strong>Update available: v{updateRelease.version}</strong><span>You are using v{appVersion}.</span></div><button className="primary" onClick={() => window.directoryAPI.openRelease(updateRelease.url)}>Download latest build</button><button className="update-close" aria-label="Dismiss update" onClick={() => setUpdateNoticeVisible(false)}>×</button></div>}
        {settingsOpen && <SettingsModal settings={settings} setSettings={setSettings} models={models} modelsLoading={modelsLoading} loadModels={loadModels} save={saveAiSettings} onClose={() => setSettingsOpen(false)} />}
        {loading && <div className="loading-backdrop"><div className="loader-card">{operationProgress === null && <span className="spinner" aria-hidden="true" />}<div className={`loader-content ${operationProgress === null ? 'indeterminate' : 'determinate'}`}><strong>{loading}</strong>{operationProgress !== null && <><div className="loading-phase"><span>{operationPhase || 'Working'}</span><b>{operationProgress}%</b></div><div className="loading-progress"><span style={{ width: `${operationProgress}%` }} /></div></>}</div></div></div>}
        <button className="floating-console-button" title="Open console" aria-label="Open console" onClick={() => setConsoleOpen(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v10a2.5 2.5 0 0 1-2.5 2.5H13l-2.5 3L8 18H6.5A2.5 2.5 0 0 1 4 15.5v-10ZM7.5 8.5l3 2.5-3 2.5m5 0h4" /></svg></button>
        {projectModal && <div className="modal-backdrop" onClick={() => setProjectModal(false)}><div className="modal project-modal" onClick={event => event.stopPropagation()}><h2>{projectEditingPath ? 'Edit project' : 'New project'}</h2><p className="muted">Set the repository path and customize its name and icon.</p><label>Project path<div className="project-path-input"><input value={projectDraft.path} onChange={event => setProjectDraft({ ...projectDraft, path: event.target.value })} placeholder="C:\\Projects\\MyRepository" /><button className="ghost" onClick={browseProjectPath}>Browse</button></div></label>{projectDraft.path && <div className="project-preview"><img src={projectDraft.icon || defaultPathIcon} alt="Project icon" /><div><strong>{projectDraft.name || projectName({ path: projectDraft.path })}</strong><small>{projectDraft.icon ? 'Custom icon' : 'Icon found in project or default icon'}</small></div><div className="project-icon-actions">{projectDraft.icon && <button className="ghost" onClick={() => setProjectDraft(value => ({ ...value, icon: null }))}>Reset default</button>}<button className="ghost" onClick={browseProjectIcon}>Choose Icon</button></div></div>}<label>Project name<input value={projectDraft.name} onChange={event => setProjectDraft({ ...projectDraft, name: event.target.value })} placeholder="Project name" /></label>{projectEditingPath && <div className="project-lfs-setting"><div><strong>Git LFS</strong><small>Manage LFS for this repository.</small></div><button className={`lfs-toggle ${projectDraft.gitLfs ? 'enabled' : ''}`} onClick={() => setLfsToggleConfirmation({ directory: projectDraft.path, enabled: !projectDraft.gitLfs })}>{projectDraft.gitLfs ? 'Enabled' : 'Disabled'}</button></div>}<div className="modal-actions"><button className="ghost" onClick={() => setProjectModal(false)}>Cancel</button><button className="primary" disabled={!projectDraft.path} onClick={saveProject}>{projectEditingPath ? 'Save changes' : 'Open project'}</button></div></div></div>}
        {lfsToggleConfirmation && <ConfirmationModal title={lfsToggleConfirmation.enabled ? 'Enable Git LFS?' : 'Disable Git LFS?'} message={lfsToggleConfirmation.enabled ? 'Git LFS will be enabled locally for this repository.' : 'Git LFS will be disabled locally for this repository. Existing tracked patterns will not be deleted.'} confirmLabel={lfsToggleConfirmation.enabled ? 'Enable LFS' : 'Disable LFS'} onCancel={() => setLfsToggleConfirmation(null)} onConfirm={confirmLfsToggle} />}
        {errorModal && <div className="modal-backdrop" onClick={() => setErrorModal('')}><div className="modal error-modal" onClick={event => event.stopPropagation()}><h2>Error</h2><pre>{errorModal}</pre><div className="modal-actions"><button className="primary" onClick={() => setErrorModal('')}>Close</button></div></div></div>}
        {assistantOpen && <div className="modal-backdrop" onClick={() => { if (!assistantBusy) setAssistantOpen(false) }}><div className="modal assistant-modal" onClick={event => event.stopPropagation()}><h2>AI .gitignore Assistant</h2><p className="muted">L’AI analizzerà il progetto e proporrà solo file e cartelle da aggiungere al `.gitignore`.</p>{!assistantPlan ? <><textarea autoFocus rows="5" disabled={assistantBusy} value={assistantPrompt} onChange={event => setAssistantPrompt(event.target.value)} placeholder="Eventuali osservazioni per l’analisi…" /><div className="modal-actions"><button className="ghost" disabled={assistantBusy} onClick={() => setAssistantOpen(false)}>Cancel</button><button className="primary" disabled={assistantBusy || !directory} onClick={generateAssistantPlan}>{assistantBusy ? 'Analyzing project…' : 'Analyze .gitignore'}</button></div></> : <><p><strong>{assistantPlan.summary || 'Voci proposte per .gitignore'}</strong></p><div className="assistant-plan-list">{assistantPlan.changes.map((change, index) => <div key={`${change.path}-${index}`}><strong>update</strong><code>.gitignore</code><small>{change.reason || 'Voci rilevate dall’AI'}</small></div>)}</div><div className="modal-actions"><button className="ghost" disabled={assistantBusy} onClick={() => setAssistantPlan(null)}>Back</button><button className="primary" disabled={assistantBusy || !assistantPlan.changes.length} onClick={applyAssistantPlan}>{assistantBusy ? 'Applying…' : 'Update .gitignore'}</button></div></>}</div></div>}
        {aboutOpen && <div className="modal-backdrop" onClick={() => setAboutOpen(false)}><div className="modal about-modal" onClick={event => event.stopPropagation()}><img className="about-mark" src={appIcon} alt="Pulse Git AI" /><p className="eyebrow">PULSE GIT AI</p><h2>Pulse Git AI</h2><p className="about-version">Version {appVersion}</p><p className="muted">A focused Git workspace with AI-assisted commit workflows.</p><button className="about-link" onClick={() => window.directoryAPI.openRelease('https://github.com/achilleterzo/Git-AI')}>Open main project on GitHub ↗</button><div className="about-meta"><div><span>DEVELOPER</span><strong>Carlo Achilleterzo Cancelloni</strong></div><div><span>LICENSE</span><strong>MIT License</strong></div></div><div className="modal-actions"><button className="primary" onClick={() => setAboutOpen(false)}>Close</button></div></div></div>}
        {pushConfirmation && <ConfirmationModal title="Confirm push" message="Review the push before sending your local commits to the remote repository." details={<><div><span>BRANCH</span><strong>{currentBranch || 'Unknown branch'}</strong></div><div><span>COMMITS TO PUSH</span><strong>{outgoingCommits}</strong></div><div><span>DIRECTORY</span><strong>{directory}</strong></div></>} confirmLabel="Push commits" onCancel={() => setPushConfirmation(false)} onConfirm={confirmPush} />}
        {revertConfirmation && <ConfirmationModal title="Revert selected files?" message="This permanently discards the selected changes and removes selected untracked files." danger details={<><div><span>FILES</span><strong>{selected.size}</strong></div><div><span>BRANCH</span><strong>{currentBranch || 'Unknown branch'}</strong></div></>} confirmLabel="Revert files" onCancel={() => setRevertConfirmation(false)} onConfirm={confirmRevert} />}
        {deleteStashConfirmation && <ConfirmationModal title={`Delete ${selectedStashes.length > 1 ? 'stashes' : 'stash'}?`} message={`This permanently deletes the selected stash${selectedStashes.length > 1 ? 'es' : ''} and all files stored in them.`} danger confirmLabel={`Delete ${selectedStashes.length > 1 ? 'stashes' : 'stash'}`} onCancel={() => setDeleteStashConfirmation(false)} onConfirm={confirmDeleteStash} />}
        {branchSwitchRequest && <ConfirmationModal title="Uncommitted changes" message="You have local changes. Stash them before switching branches?" details={<><div><span>CURRENT BRANCH</span><strong>{currentBranch || 'Unknown branch'}</strong></div><div><span>CHANGES</span><strong>{changes.length}</strong></div><div><span>TARGET</span><strong>{branchSwitchRequest.newBranch || branchSwitchRequest.target}</strong></div></>} confirmLabel="Stash and switch" onCancel={() => setBranchSwitchRequest(null)} onConfirm={() => executeBranchSwitch(branchSwitchRequest, true)} />}
        <div className={`modal-backdrop ${consoleOpen ? '' : 'console-modal-hidden'}`} onClick={() => setConsoleOpen(false)}><div className="modal console-modal" onClick={event => event.stopPropagation()}><div className="console-modal-head"><span className="eyebrow ml-2">CONSOLE</span><div className="console-head-actions"><button className="ghost console-copy-button" onClick={() => copyConsoleContent(consoleTab === 'ai' ? 'request' : 'service')} title="Copy active tab" aria-label="Copy active tab"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 16V6a2 2 0 0 1 2-2h10" /></svg></button><button className="console-close-button" title="Close console" aria-label="Close console" onClick={() => setConsoleOpen(false)}>×</button></div></div><div className="console-layout"><nav className="console-menu"><button className={consoleTab === 'ai' ? 'active' : ''} onClick={() => setConsoleTab('ai')}>Last request</button><button className={consoleTab === 'service' ? 'active' : ''} onClick={() => setConsoleTab('service')}>Service log</button><button className={consoleTab === 'shell' ? 'active' : ''} onClick={() => setConsoleTab('shell')}>Shell</button>{window.directoryAPI.isDevelopment && <button onClick={() => window.directoryAPI.openDevTools()}>Developer tools</button>}</nav><section className="console-panel">{consoleTab === 'ai' && <pre>{aiPromptLog ? JSON.stringify(aiPromptLog, null, 2) : 'No AI prompt recorded yet.'}</pre>}{consoleTab === 'service' && <pre>{consoleLines.length ? consoleLines.map(line => `[${line.at ? new Date(line.at).toLocaleTimeString() : '--:--:--'}] ${line.message}`).join('\n') : 'No service log entries yet.'}</pre>}<div className={consoleTab === 'shell' ? 'console-shell-visible' : 'console-shell-hidden'}><TerminalConsole directory={directory} visible={consoleOpen && consoleTab === 'shell'} /></div></section></div></div></div>
        {diffModal && <div className="modal-backdrop" onClick={() => setDiffModal(null)}><div className="modal diff-modal" onClick={event => event.stopPropagation()}><h2>Diff</h2><p className="muted">{diffModal.file}</p><pre>{diffModal.diff}</pre><div className="modal-actions"><button className="primary" onClick={() => setDiffModal(null)}>Close</button></div></div></div>}
        {(settingsOpen || aiMessage || aiError) && <div className="modal-backdrop" onClick={() => { if (!aiBusy) { setSettingsOpen(false); setAiMessage(''); setAiError('') } }}><div className="modal" onClick={event => event.stopPropagation()}>{settingsOpen ? <><h2>AI Settings</h2><p className="muted">Configure Ollama to generate commit messages.</p><label>Ollama endpoint<input value={settings.endpoint} onChange={event => setSettings({ ...settings, endpoint: event.target.value })} /></label><label>Model<select value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value })}><option value="">Select a model</option>{settings.model && !models.includes(settings.model) && <option value={settings.model}>{settings.model}</option>}{models.map(model => <option key={model} value={model}>{model}</option>)}</select></label><label>Message language<select value={settings.language} onChange={event => setSettings({ ...settings, language: event.target.value })}>{['English', 'Italian', 'Spanish', 'French', 'German', 'Portuguese', 'Chinese', 'Japanese'].map(language => <option key={language} value={language}>{language}</option>)}</select></label><div className="modal-actions"><button className="ghost" onClick={() => loadModels()} disabled={modelsLoading}>{modelsLoading ? 'Loading…' : 'Load models'}</button><button className="primary" onClick={saveAiSettings}>Save</button></div>{aiError && <p className="modal-error">{aiError}</p>}</> : <><h2>{pendingOperation === 'stash-merge' ? 'Merge stash message' : pendingOperation === 'stash' ? 'Stash message' : pendingOperation === 'amend' ? 'Amend commit message' : 'Commit message'}</h2><textarea value={aiMessage} onChange={event => setAiMessage(event.target.value)} /><div className="modal-actions"><button className="ghost" onClick={() => { setAiMessage(''); setAiError('') }}>Close</button>{aiError && <button className="ghost" onClick={() => pendingOperation === 'stash-merge' ? generateStashMergeMessage() : generateCommitMessage(pendingOperation)} disabled={aiBusy}>{aiBusy ? 'Retrying…' : 'Retry'}</button>}{pendingOperation === 'stash-merge' ? <button className="primary" onClick={mergeStashes} disabled={aiBusy || !aiMessage.trim()}>Merge stashes</button> : pendingOperation === 'stash' ? <button className="primary" onClick={stashSelected} disabled={aiBusy || !aiMessage.trim()}>Stash</button> : <button className="primary" onClick={commitSelected} disabled={aiBusy || !aiMessage.trim()}>{pendingOperation === 'amend' ? 'Amend commit' : 'Commit'}</button>}</div></>}</div></div>}
      </section>
    </main>
  )
}
createRoot(document.getElementById('root')).render(<App />)
