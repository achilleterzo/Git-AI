import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import packageJson from '../package.json'
import appIcon from '../assets/pulse-git-ai.png'
import ChangesPage from './pages/ChangesPage'
import StashPage from './pages/StashPage'
import WatchingPill from './components/WatchingPill'
import LfsPill from './components/LfsPill'
import LfsPage from './pages/LfsPage'
import TerminalConsole from './components/TerminalConsole'
import './styles.css'

const defaultPathIcon = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Cpath fill="%235eead4" d="M3 5.5A2.5 2.5 0 0 1 5.5 3h5l2 2H18a3 3 0 0 1 3 3v1H3v-3.5Zm0 5.5h18v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-7Z"/%3E%3C/svg%3E'
const normalizeProjects = list => (Array.isArray(list) ? list : []).map(project => typeof project === 'string' ? { path: project, icon: null } : project).filter(project => typeof project?.path === 'string' && project.path)
const projectName = project => { const directory = typeof project?.path === 'string' ? project.path : ''; return project?.name || directory.split(/[\\/]/).filter(Boolean).at(-1) || directory || 'Unnamed project' }
const compareVersions = (left, right) => { const a = String(left || '').split('.').map(Number); const b = String(right || '').split('.').map(Number); for (let index = 0; index < 3; index += 1) { const difference = (a[index] || 0) - (b[index] || 0); if (difference) return difference } return 0 }

const formatSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
const cappedCount = count => Number(count) > 999 ? '+999' : String(Number(count) || 0)

function App() {
  const [directory, setDirectory] = useState('')
  const [files, setFiles] = useState([])
  const [changes, setChanges] = useState([])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [expanded, setExpanded] = useState(new Set(['']))
  const [settingsOpen, setSettingsOpen] = useState(false)
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
  const [settings, setSettings] = useState({ endpoint: 'http://localhost:11434', model: '', language: 'English' })
  const [models, setModels] = useState([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMessage, setAiMessage] = useState('')
  const [aiError, setAiError] = useState('')
  const [projects, setProjects] = useState([])
  const [gitBusy, setGitBusy] = useState(false)
  const [incomingCommits, setIncomingCommits] = useState(0)
  const [outgoingCommits, setOutgoingCommits] = useState(0)
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
  const [selectedStashes, setSelectedStashes] = useState([])
  const [expandedStashRef, setExpandedStashRef] = useState('')
  const [loading, setLoading] = useState('')
  const [operationProgress, setOperationProgress] = useState(null)
  const [consoleLines, setConsoleLines] = useState([])
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleCommand, setConsoleCommand] = useState('')
  const [projectIcon, setProjectIcon] = useState(null)
  const [pendingOperation, setPendingOperation] = useState('commit')
  const [lastEvent, setLastEvent] = useState('Waiting for a directory')
  const pendingRefreshRef = useRef('')
  const visibleChanges = useMemo(() => changes.filter(c => c.file.toLowerCase().includes(query.toLowerCase())), [changes, query])
  const allPaths = visibleChanges.map(change => change.file)
  const allSelected = allPaths.length > 0 && allPaths.every(path => selected.has(path))
  const allPartial = allPaths.some(path => selected.has(path)) && !allSelected
  async function runShellCommand(event) { event.preventDefault(); const command = consoleCommand.trim(); if (!command || !directory) return; setConsoleCommand(''); try { await window.directoryAPI.runShellCommand(command) } catch (error) { setConsoleLines(lines => [...lines, { at: new Date().toISOString(), message: `Error: ${error.message}` }].slice(-300)) } }

  useEffect(() => { window.directoryAPI.getSettings().then(setSettings); window.directoryAPI.getAppVersion().then(version => { setAppVersion(version); window.directoryAPI.getLatestRelease().then(release => { if (release?.version && compareVersions(release.version, version) > 0) setUpdateRelease(release) }).catch(() => {}) }).catch(() => {}); window.directoryAPI.getProjects().then(async result => { const savedProjects = normalizeProjects(result); setProjects(savedProjects); const lastProject = savedProjects.slice().sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))[0]; if (lastProject?.lastOpened) { setLoading('Restoring project…'); await openSelectedDirectory(lastProject.path, lastProject); pendingRefreshRef.current = ''; setLoading('') } else setView('home') }); window.directoryAPI.onOpenSettings(() => setSettingsOpen(true)); window.directoryAPI.onOpenAbout(() => setAboutOpen(true)); return undefined }, [])
  useEffect(() => { window.directoryAPI.onOperationLog(data => setConsoleLines(lines => [...lines, { ...data, message: String(data?.message || '') }].slice(-300))); return undefined }, [])
  useEffect(() => { window.directoryAPI.onUpdate(data => {
    setFiles(data.files || [])
    setChanges(data.changes || [])
    setIncomingCommits(Number(data.incomingCommits) || 0)
    setOutgoingCommits(Number(data.outgoingCommits) || 0)
    setCurrentBranch(String(data.branch || '').trim())
    setGitLfs(Boolean(data.gitLfs))
    if (pendingRefreshRef.current && data.reason === pendingRefreshRef.current) { pendingRefreshRef.current = ''; setLoading('') }
    if (data.directory) setProjects(value => value.map(project => project.path === data.directory ? { ...project, gitLfs: Boolean(data.gitLfs), icon: data.projectIcon || project.icon } : project))
    if (data.reason === 'directory-removed') {
      setActive(false)
      setProjects(value => value.filter(project => project.path !== data.removedDirectory))
      setView('home')
    }
    setDirectory(data.directory || '')
    setProjectIcon(data.projectIcon || projects.find(project => project.path === data.directory)?.icon || null)
    setActive(true)
    if (data.gitOk) setSelected(previous => {
      const currentPaths = new Set((data.changes || []).map(change => change.file))
      return new Set([...previous].filter(path => currentPaths.has(path)))
    })
    if (data.error) setErrorModal(data.error)
    else if (['git-pull', 'git-push', 'post-commit'].includes(data.reason)) setLastEvent(data.reason === 'post-commit' ? 'Commit completed' : data.reason === 'git-push' ? 'Push completed' : 'Pull completed')
  }) }, [])
  useEffect(() => { if (view === 'stash' && directory) window.directoryAPI.getStashes().then(setStashes).catch(error => setErrorModal(error.message)) }, [view, directory, active])
  useEffect(() => { if (view === 'lfs' && !gitLfs) setView('changes') }, [view, gitLfs])
  useEffect(() => { if (projectModal && projectDraft.path) window.directoryAPI.getProjectIcon(projectDraft.path).then(icon => setProjectDraft(value => value.path === projectDraft.path && !value.icon ? { ...value, icon } : value)).catch(() => {}) }, [projectModal, projectDraft.path])
  useEffect(() => { if (settingsOpen) loadModels(settings.endpoint) }, [settingsOpen])
  useEffect(() => { if (!updateRelease) return undefined; setUpdateNoticeVisible(true); const timer = setTimeout(() => setUpdateNoticeVisible(false), 9000); return () => clearTimeout(timer) }, [updateRelease])
  async function choose() { setProjectEditingPath(''); setProjectDraft({ path: '', name: '', icon: null, gitLfs: false }); setProjectModal(true) }
  async function browseProjectPath() { const selected = await window.directoryAPI.chooseDirectory(projectDraft.path); if (selected) { const icon = await window.directoryAPI.getProjectIcon(selected); setProjectDraft(value => ({ ...value, path: selected, name: value.name || projectName({ path: selected }), icon })) } }
  async function browseProjectIcon() { try { const icon = await window.directoryAPI.chooseProjectIcon(projectDraft.path); if (icon) setProjectDraft(value => ({ ...value, icon })) } catch (error) { setErrorModal(error.message) } }
  async function editProject(project) { setProjectEditingPath(project.path); setProjectDraft({ path: project.path, name: project.name || projectName(project), icon: project.icon || null, gitLfs: project.gitLfs === true }); setProjectModal(true) }
  async function confirmLfsToggle() { const request = lfsToggleConfirmation; setLfsToggleConfirmation(null); if (!request) return; setLoading(request.enabled ? 'Enabling Git LFS…' : 'Disabling Git LFS…'); try { await window.directoryAPI.setLfsEnabled(request.directory, request.enabled); setProjectDraft(value => value.path === request.directory ? { ...value, gitLfs: request.enabled } : value); setProjects(value => value.map(project => project.path === request.directory ? { ...project, gitLfs: request.enabled } : project)); if (directory === request.directory) setGitLfs(request.enabled) } catch (error) { setErrorModal(error.message) } finally { setLoading('') } }
  async function openSelectedDirectory(path, project) { const metadata = project || { path }; setDirectory(path); setProjectIcon(metadata.icon || null); setCurrentBranch(''); setIncomingCommits(0); setOutgoingCommits(0); setGitLfs(Boolean(metadata.gitLfs)); setActive(false); setFiles([]); setChanges([]); setSelected(new Set()); setStashes([]); setEmptyDirectory(''); setCheckoutRemote(''); pendingRefreshRef.current = 'started'; try { await window.directoryAPI.startWatching(path); setProjects(normalizeProjects(await window.directoryAPI.addProject(metadata))); setView('changes'); return true } catch (error) { pendingRefreshRef.current = ''; const message = String(error?.message || error || ''); if (error.code === 'EMPTY_DIRECTORY_NOT_REPOSITORY' || message.includes('empty and is not a Git repository')) { setProjects(normalizeProjects(await window.directoryAPI.addProject(metadata))); setActive(false); setEmptyDirectory(path); setProjectModal(false); setView('changes'); return false } setErrorModal(message); return false } }
  async function saveProject() { if (!projectDraft.path) return; const editing = Boolean(projectEditingPath); const project = { ...projectDraft, name: projectDraft.name.trim() || projectName({ path: projectDraft.path }), ...(editing ? {} : { lastOpened: Date.now() }) }; setLoading(editing ? 'Saving project…' : 'Loading project…'); try { if (editing) { if (projectEditingPath !== projectDraft.path) { await window.directoryAPI.removeProject(projectEditingPath); setProjects(normalizeProjects(await window.directoryAPI.addProject(project))) } else setProjects(normalizeProjects(await window.directoryAPI.updateProject(projectEditingPath, project))); setProjectModal(false) } else if (await openSelectedDirectory(projectDraft.path, project)) setProjectModal(false); setProjectEditingPath('') } finally { if (!pendingRefreshRef.current) setLoading('') } }
  async function selectProject(option) { if (option?.value) { setLoading('Loading project…'); await openSelectedDirectory(option.value, { path: option.value, lastOpened: Date.now() }); if (!pendingRefreshRef.current) setLoading('') } }
  async function initializeEmptyDirectory() { setLoading('Initializing Git…'); try { await window.directoryAPI.initializeRepository(emptyDirectory); setProjects(normalizeProjects(await window.directoryAPI.addProject({ path: emptyDirectory, lastOpened: Date.now() }))); setEmptyDirectory(''); setView('changes') } catch (error) { setErrorModal(error.message) } finally { setLoading('') } }
  async function checkoutEmptyDirectory() { setLoading('Checking out repository…'); try { await window.directoryAPI.checkoutRepository(emptyDirectory, checkoutRemote); setProjects(normalizeProjects(await window.directoryAPI.addProject({ path: emptyDirectory, lastOpened: Date.now() }))); setEmptyDirectory(''); setView('changes') } catch (error) { setErrorModal(error.message) } finally { setLoading('') } }
  async function openHomeProject(project) { setView('changes'); await selectProject({ value: project.path }) }
  async function removeProjectOption(option) { if (!option || !window.confirm(`Remove "${option.value}" from the project list?\nNo files will be deleted.`)) return; try { const isCurrent = directory === option.value || emptyDirectory === option.value; if (directory === option.value) await window.directoryAPI.stopWatching(); setProjects(normalizeProjects(await window.directoryAPI.removeProject(option.value))); if (isCurrent) { setDirectory(''); setActive(false); setFiles([]); setChanges([]); setGitLfs(false); setEmptyDirectory(''); setSelected(new Set()); setView('home') } } catch (error) { setErrorModal(error.message) } }
  async function resume() { if (directory) { setLoading('Starting monitor…'); try { await window.directoryAPI.startWatching(directory) } finally { setLoading('') } } }
  async function stop() { await window.directoryAPI.stopWatching(); setActive(false); setFiles([]); setChanges([]); setSelected(new Set()); setLastEvent('Monitor stopped') }
  function toggleFolder(path) { setExpanded(value => { const next = new Set(value); next.has(path) ? next.delete(path) : next.add(path); return next }) }
  function toggleSelection(paths) { setSelected(value => { const next = new Set(value); const all = paths.every(path => next.has(path)); paths.forEach(path => all ? next.delete(path) : next.add(path)); return next }) }
  async function loadModels(endpoint = settings.endpoint) { setAiError(''); setModelsLoading(true); try { const result = await window.directoryAPI.fetchModels(endpoint); setModels(value => settings.model && !result.includes(settings.model) ? [settings.model, ...result] : result); if (!settings.model && result[0]) setSettings(value => ({ ...value, model: result[0] })) } catch (error) { setAiError(error.message) } finally { setModelsLoading(false) } }
  async function saveAiSettings() { setAiError(''); try { await window.directoryAPI.saveSettings(settings); setSettingsOpen(false) } catch (error) { setErrorModal(error.message) } }
  async function generateCommitMessage(operation = 'commit') { setPendingOperation(operation); setAiBusy(true); setLoading(operation === 'stash' ? 'Generating stash message…' : 'Generating commit message…'); setAiError(''); try { setAiMessage(await window.directoryAPI.generateCommitMessage([...selected], operation)) } catch (error) { setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false); setLoading('') } }
  async function generateStashMergeMessage() { setPendingOperation('stash-merge'); setAiBusy(true); setLoading('Generating stash merge message…'); setAiError(''); try { setAiMessage(await window.directoryAPI.generateStashMergeMessage(selectedStashes.map(stash => stash.ref))) } catch (error) { setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false); setLoading('') } }
  async function openDiff(file) { try { setDiffModal({ file, diff: await window.directoryAPI.getDiff(file) }) } catch (error) { setErrorModal(error.message) } }
  async function commitSelected() { setAiBusy(true); setLoading('Creating commit…'); setAiError(''); pendingRefreshRef.current = 'post-commit'; try { await window.directoryAPI.commitSelected([...selected], aiMessage); setAiMessage(''); setSelected(new Set()); setLastEvent('Commit completed') } catch (error) { pendingRefreshRef.current = ''; setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false); if (!pendingRefreshRef.current) setLoading('') } }
  async function stashSelected() { setAiBusy(true); setLoading('Creating stash…'); setAiError(''); pendingRefreshRef.current = 'stash-created'; try { await window.directoryAPI.stashSelected([...selected], aiMessage); setAiMessage(''); setSelected(new Set()); setLastEvent('Stash created'); setStashes(await window.directoryAPI.getStashes()) } catch (error) { pendingRefreshRef.current = ''; setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false); if (!pendingRefreshRef.current) setLoading('') } }
  async function restoreStash({ partialRef = '', files = [] } = {}) { if (!selectedStashes.length && !(partialRef && files.length)) return; setGitBusy(true); setLoading(files.length ? `Recovering ${files.length} stash file${files.length > 1 ? 's' : ''}…` : `Recovering ${selectedStashes.length} stash${selectedStashes.length > 1 ? 'es' : ''}…`); pendingRefreshRef.current = files.length ? 'stash-files-restore' : 'stash-pop'; try { if (files.length && partialRef) await window.directoryAPI.unstashFiles(partialRef, files); else if (selectedStashes.length > 1) await window.directoryAPI.unstashMany(selectedStashes.map(stash => stash.ref)); else await window.directoryAPI.unstash(selectedStashes[0].ref); if (!files.length) setSelectedStashes([]); setStashes(await window.directoryAPI.getStashes()) } catch (error) { pendingRefreshRef.current = ''; setErrorModal(error.message) } finally { setGitBusy(false); if (!pendingRefreshRef.current) setLoading('') } }
  async function mergeStashes() { setAiBusy(true); setLoading('Merging stashes…'); setAiError(''); pendingRefreshRef.current = 'stash-merge'; try { await window.directoryAPI.mergeStashes(selectedStashes.map(stash => stash.ref), aiMessage); setAiMessage(''); setSelectedStashes([]); setStashes(await window.directoryAPI.getStashes()) } catch (error) { pendingRefreshRef.current = ''; setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false); if (!pendingRefreshRef.current) setLoading('') } }
  function requestDeleteStash() { if (selectedStashes.length) setDeleteStashConfirmation(true) }
  async function confirmDeleteStash() { setDeleteStashConfirmation(false); setGitBusy(true); setLoading(`Deleting ${selectedStashes.length} stash${selectedStashes.length > 1 ? 'es' : ''}…`); pendingRefreshRef.current = 'stash-delete'; try { if (selectedStashes.length > 1) await window.directoryAPI.deleteStashes(selectedStashes.map(stash => stash.ref)); else await window.directoryAPI.deleteStash(selectedStashes[0].ref); setSelectedStashes([]); setStashes(await window.directoryAPI.getStashes()) } catch (error) { pendingRefreshRef.current = ''; setErrorModal(error.message) } finally { setGitBusy(false); if (!pendingRefreshRef.current) setLoading('') } }
  function requestRevert() { if (selected.size) setRevertConfirmation(true) }
  async function confirmRevert() { setRevertConfirmation(false); setGitBusy(true); setLoading('Reverting selected files…'); pendingRefreshRef.current = 'revert-files'; try { await window.directoryAPI.revertFiles([...selected]); setSelected(new Set()) } catch (error) { pendingRefreshRef.current = ''; setErrorModal(error.message) } finally { setGitBusy(false); if (!pendingRefreshRef.current) setLoading('') } }
  async function requestPush() { if (!directory || gitBusy || outgoingCommits < 1) return; setPushConfirmation(true) }
  async function runGitRemote(action, confirmed = false) { if (action === 'push' && !confirmed) { if (!directory || gitBusy || outgoingCommits < 1) return; setPushConfirmation(true); return } setGitBusy(true); setLoading(`${action === 'push' ? 'Pushing changes…' : 'Pulling changes…'}`); pendingRefreshRef.current = action === 'push' ? 'git-push' : 'git-pull'; try { const result = action === 'pull' ? await window.directoryAPI.gitPull() : await window.directoryAPI.gitPush(); setLastEvent(result || `${action === 'push' ? 'Push' : 'Pull'} completed`) } catch (error) { pendingRefreshRef.current = ''; setErrorModal(error.message) } finally { setGitBusy(false); if (!pendingRefreshRef.current) setLoading('') } }
  async function handleBranchSwitch(request) { if (request?.error) { setErrorModal(request.error); return } if (changes.length > 0) { setBranchSwitchRequest(request); return } await executeBranchSwitch(request, false) }
  async function executeBranchSwitch(request, stash) { setBranchSwitchRequest(null); setLoading(stash ? 'Stashing changes and switching branch…' : 'Switching branch…'); pendingRefreshRef.current = 'branch-switch'; try { await window.directoryAPI.switchBranch({ ...request, stash }); setSelected(new Set()) } catch (error) { pendingRefreshRef.current = ''; setErrorModal(error.message) } finally { if (!pendingRefreshRef.current) setLoading('') } }
  async function confirmPush() { setPushConfirmation(false); await runGitRemote('push', true) }
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
    selected,
    aiBusy,
    gitBusy,
    generateCommitMessage,
    runGitRemote,
    requestPush,
    changes,
    query,
    setQuery,
    expanded,
    toggleFolder,
    toggleSelection,
    openDiff,
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
        <div className="side-footer">Pulse Git AI<br /><span>v{appVersion} · ready</span>{updateRelease && <button className="update-pill" onClick={() => window.directoryAPI.openRelease(updateRelease.url)}>Update v{updateRelease.version}</button>}</div>
      </aside>

      <section className="content">
        {view === 'home' ? (
          <div className="home-page">
            <header>
              <div>
                <p className="eyebrow">WORKSPACE / HOME</p>
                <h1>Projects</h1>
                <p className="muted">Open one of your saved Git repositories.</p>
              </div>
            </header>
            <div className="home-project-grid">
              <button className="home-project-card new-project-card" onClick={choose}>
                <span className="new-project-icon">＋</span>
                <span>New project</span>
                <small>Choose a directory</small>
              </button>
              {projects.slice().sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0)).map(project => (
                <div className={`home-project-card project-card ${project.path === directory ? 'active' : ''}`} key={project.path} title={project.path} onClick={() => openHomeProject(project)}>
                  <div className="project-card-icon-row">
                    <img src={project.icon || defaultPathIcon} alt="" />
                    <LfsPill active={project.gitLfs === true} directory={project.path} />
                  </div>
                  <span>{projectName(project)}</span>
                  <small>Open project</small>
                  <button className="project-edit-button" title="Edit project" onClick={event => { event.stopPropagation(); editProject(project) }}>Edit</button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            <header className="page-header page-header-compact"><span className="eyebrow">WORKSPACE / MONITOR</span><WatchingPill active={active} directory={directory} stop={stop} resume={resume} /></header>
            {view === 'changes' ? <ChangesPage {...pageProps} /> : view === 'stash' ? <StashPage {...pageProps} stashes={stashes} /> : <LfsPage directory={directory} gitLfs={gitLfs} loading={loading} setLoading={setLoading} setErrorModal={setErrorModal} />}
          </>
        )}

        {updateRelease && updateNoticeVisible && <div className="update-banner"><div><strong>Update available: v{updateRelease.version}</strong><span>You are using v{appVersion}.</span></div><button className="primary" onClick={() => window.directoryAPI.openRelease(updateRelease.url)}>Download latest build</button><button className="update-close" aria-label="Dismiss update" onClick={() => setUpdateNoticeVisible(false)}>×</button></div>}
        {loading && <div className="loading-backdrop"><div className="loader-card">{operationProgress === null && <span className="spinner" aria-hidden="true" />}<div className={`loader-content ${operationProgress === null ? 'indeterminate' : 'determinate'}`}><strong>{loading}</strong>{operationProgress !== null && <div className="loading-progress"><span style={{ width: `${operationProgress}%` }} /></div>}</div></div></div>}
        <button className="floating-console-button" title="Open console" aria-label="Open console" onClick={() => setConsoleOpen(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v10a2.5 2.5 0 0 1-2.5 2.5H13l-2.5 3L8 18H6.5A2.5 2.5 0 0 1 4 15.5v-10ZM7.5 8.5l3 2.5-3 2.5m5 0h4" /></svg>{consoleLines.length > 0 && <span>{consoleLines.length > 99 ? '99+' : consoleLines.length}</span>}</button>
        {projectModal && <div className="modal-backdrop" onClick={() => setProjectModal(false)}><div className="modal project-modal" onClick={event => event.stopPropagation()}><h2>{projectEditingPath ? 'Edit project' : 'New project'}</h2><p className="muted">Set the repository path and customize its name and icon.</p><label>Project path<div className="project-path-input"><input value={projectDraft.path} onChange={event => setProjectDraft({ ...projectDraft, path: event.target.value })} placeholder="C:\\Projects\\MyRepository" /><button className="ghost" onClick={browseProjectPath}>Browse</button></div></label>{projectDraft.path && <div className="project-preview"><img src={projectDraft.icon || defaultPathIcon} alt="Project icon" /><div><strong>{projectDraft.name || projectName({ path: projectDraft.path })}</strong><small>{projectDraft.icon ? 'Custom icon' : 'Icon found in project or default icon'}</small></div><div className="project-icon-actions">{projectDraft.icon && <button className="ghost" onClick={() => setProjectDraft(value => ({ ...value, icon: null }))}>Reset default</button>}<button className="ghost" onClick={browseProjectIcon}>Choose Icon</button></div></div>}<label>Project name<input value={projectDraft.name} onChange={event => setProjectDraft({ ...projectDraft, name: event.target.value })} placeholder="Project name" /></label>{projectEditingPath && <div className="project-lfs-setting"><div><strong>Git LFS</strong><small>Manage LFS for this repository.</small></div><button className={`lfs-toggle ${projectDraft.gitLfs ? 'enabled' : ''}`} onClick={() => setLfsToggleConfirmation({ directory: projectDraft.path, enabled: !projectDraft.gitLfs })}>{projectDraft.gitLfs ? 'Enabled' : 'Disabled'}</button></div>}<div className="modal-actions"><button className="ghost" onClick={() => setProjectModal(false)}>Cancel</button><button className="primary" disabled={!projectDraft.path} onClick={saveProject}>{projectEditingPath ? 'Save changes' : 'Open project'}</button></div></div></div>}
        {lfsToggleConfirmation && <div className="modal-backdrop" onClick={() => setLfsToggleConfirmation(null)}><div className="modal" onClick={event => event.stopPropagation()}><h2>{lfsToggleConfirmation.enabled ? 'Enable Git LFS?' : 'Disable Git LFS?'}</h2><p className="muted">{lfsToggleConfirmation.enabled ? 'Git LFS will be enabled locally for this repository.' : 'Git LFS will be disabled locally for this repository. Existing tracked patterns will not be deleted.'}</p><div className="modal-actions"><button className="ghost" onClick={() => setLfsToggleConfirmation(null)}>Cancel</button><button className="primary" onClick={confirmLfsToggle}>{lfsToggleConfirmation.enabled ? 'Enable LFS' : 'Disable LFS'}</button></div></div></div>}
        {errorModal && <div className="modal-backdrop" onClick={() => setErrorModal('')}><div className="modal error-modal" onClick={event => event.stopPropagation()}><h2>Error</h2><pre>{errorModal}</pre><div className="modal-actions"><button className="primary" onClick={() => setErrorModal('')}>Close</button></div></div></div>}
        {aboutOpen && <div className="modal-backdrop" onClick={() => setAboutOpen(false)}><div className="modal about-modal" onClick={event => event.stopPropagation()}><img className="about-mark" src={appIcon} alt="Pulse Git AI" /><p className="eyebrow">PULSE GIT AI</p><h2>Pulse Git AI</h2><p className="about-version">Version {appVersion}</p><p className="muted">A focused Git workspace with AI-assisted commit workflows.</p><button className="about-link" onClick={() => window.directoryAPI.openRelease('https://github.com/achilleterzo/Git-AI')}>Open main project on GitHub ↗</button><div className="about-meta"><div><span>DEVELOPER</span><strong>Carlo Achilleterzo Cancelloni</strong></div><div><span>LICENSE</span><strong>MIT License</strong></div></div><div className="modal-actions"><button className="primary" onClick={() => setAboutOpen(false)}>Close</button></div></div></div>}
        {pushConfirmation && <div className="modal-backdrop" onClick={() => setPushConfirmation(false)}><div className="modal" onClick={event => event.stopPropagation()}><h2>Confirm push</h2><p className="muted">Review the push before sending your local commits to the remote repository.</p><div className="push-summary"><div><span>BRANCH</span><strong>{currentBranch || 'Unknown branch'}</strong></div><div><span>COMMITS TO PUSH</span><strong>{outgoingCommits}</strong></div><div><span>DIRECTORY</span><strong>{directory}</strong></div></div><div className="modal-actions"><button className="ghost" onClick={() => setPushConfirmation(false)}>Cancel</button><button className="primary" onClick={confirmPush}>Push commits</button></div></div></div>}
        {revertConfirmation && <div className="modal-backdrop" onClick={() => setRevertConfirmation(false)}><div className="modal" onClick={event => event.stopPropagation()}><h2>Revert selected files?</h2><p className="muted">This permanently discards the selected changes and removes selected untracked files.</p><div className="push-summary"><div><span>FILES</span><strong>{selected.size}</strong></div><div><span>BRANCH</span><strong>{currentBranch || 'Unknown branch'}</strong></div></div><div className="modal-actions"><button className="ghost" onClick={() => setRevertConfirmation(false)}>Cancel</button><button className="danger-button primary" onClick={confirmRevert}>Revert files</button></div></div></div>}
        {deleteStashConfirmation && <div className="modal-backdrop" onClick={() => setDeleteStashConfirmation(false)}><div className="modal" onClick={event => event.stopPropagation()}><h2>Delete {selectedStashes.length > 1 ? 'stashes' : 'stash'}?</h2><p className="muted">This permanently deletes the selected stash{selectedStashes.length > 1 ? 'es' : ''} and all files stored in them.</p><div className="modal-actions"><button className="ghost" onClick={() => setDeleteStashConfirmation(false)}>Cancel</button><button className="danger-button primary" onClick={confirmDeleteStash}>Delete {selectedStashes.length > 1 ? 'stashes' : 'stash'}</button></div></div></div>}
        {branchSwitchRequest && <div className="modal-backdrop" onClick={() => setBranchSwitchRequest(null)}><div className="modal" onClick={event => event.stopPropagation()}><h2>Uncommitted changes</h2><p className="muted">You have local changes. Stash them before switching branches?</p><div className="push-summary"><div><span>CURRENT BRANCH</span><strong>{currentBranch || 'Unknown branch'}</strong></div><div><span>CHANGES</span><strong>{changes.length}</strong></div><div><span>TARGET</span><strong>{branchSwitchRequest.newBranch || branchSwitchRequest.target}</strong></div></div><div className="modal-actions"><button className="ghost" onClick={() => setBranchSwitchRequest(null)}>Cancel</button><button className="primary" onClick={() => executeBranchSwitch(branchSwitchRequest, true)}>Stash and switch</button></div></div></div>}
        <div className={`modal-backdrop ${consoleOpen ? '' : 'console-modal-hidden'}`} onClick={() => setConsoleOpen(false)}><div className="modal console-modal" onClick={event => event.stopPropagation()}><div className="console-modal-head"><span className="eyebrow ml-2">CONSOLE</span><button className="console-close-button" title="Close console" aria-label="Close console" onClick={() => setConsoleOpen(false)}>×</button></div><TerminalConsole directory={directory} visible={consoleOpen} /></div></div>
        {diffModal && <div className="modal-backdrop" onClick={() => setDiffModal(null)}><div className="modal diff-modal" onClick={event => event.stopPropagation()}><h2>Diff</h2><p className="muted">{diffModal.file}</p><pre>{diffModal.diff}</pre><div className="modal-actions"><button className="primary" onClick={() => setDiffModal(null)}>Close</button></div></div></div>}
        {(settingsOpen || aiMessage || aiError) && <div className="modal-backdrop" onClick={() => { if (!aiBusy) { setSettingsOpen(false); setAiMessage(''); setAiError('') } }}><div className="modal" onClick={event => event.stopPropagation()}>{settingsOpen ? <><h2>AI Settings</h2><p className="muted">Configure Ollama to generate commit messages.</p><label>Ollama endpoint<input value={settings.endpoint} onChange={event => setSettings({ ...settings, endpoint: event.target.value })} /></label><label>Model<select value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value })}><option value="">Select a model</option>{settings.model && !models.includes(settings.model) && <option value={settings.model}>{settings.model}</option>}{models.map(model => <option key={model} value={model}>{model}</option>)}</select></label><label>Message language<select value={settings.language} onChange={event => setSettings({ ...settings, language: event.target.value })}>{['English', 'Italian', 'Spanish', 'French', 'German', 'Portuguese', 'Chinese', 'Japanese'].map(language => <option key={language} value={language}>{language}</option>)}</select></label><div className="modal-actions"><button className="ghost" onClick={() => loadModels()} disabled={modelsLoading}>{modelsLoading ? 'Loading…' : 'Load models'}</button><button className="primary" onClick={saveAiSettings}>Save</button></div>{aiError && <p className="modal-error">{aiError}</p>}</> : <><h2>{pendingOperation === 'stash-merge' ? 'Merge stash message' : pendingOperation === 'stash' ? 'Stash message' : 'Commit message'}</h2><textarea value={aiMessage} onChange={event => setAiMessage(event.target.value)} /><div className="modal-actions"><button className="ghost" onClick={() => { setAiMessage(''); setAiError('') }}>Close</button>{aiError && <button className="ghost" onClick={() => pendingOperation === 'stash-merge' ? generateStashMergeMessage() : generateCommitMessage(pendingOperation)} disabled={aiBusy}>{aiBusy ? 'Retrying…' : 'Retry'}</button>}{pendingOperation === 'stash-merge' ? <button className="primary" onClick={mergeStashes} disabled={aiBusy || !aiMessage.trim()}>Merge stashes</button> : pendingOperation === 'stash' ? <button className="primary" onClick={stashSelected} disabled={aiBusy || !aiMessage.trim()}>Stash</button> : <button className="primary" onClick={commitSelected} disabled={aiBusy || !aiMessage.trim()}>Commit</button>}</div></>}</div></div>}
      </section>
    </main>
  )
}
createRoot(document.getElementById('root')).render(<App />)
