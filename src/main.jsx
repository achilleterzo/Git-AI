import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Select, { components } from 'react-select'
import './styles.css'

const defaultPathIcon = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Cpath fill="%235eead4" d="M3 5.5A2.5 2.5 0 0 1 5.5 3h5l2 2H18a3 3 0 0 1 3 3v1H3v-3.5Zm0 5.5h18v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-7Z"/%3E%3C/svg%3E'
const normalizeProjects = list => (Array.isArray(list) ? list : []).map(project => typeof project === 'string' ? { path: project, icon: null } : project).filter(project => project?.path)
const projectName = project => project.name || project.path.split(/[\\/]/).filter(Boolean).at(-1) || project.path

const formatSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

function buildTree(changes) {
  const root = { name: '.', path: '', folders: new Map(), files: [] }
  for (const change of changes) {
    const parts = change.file.replaceAll('\\', '/').split('/').filter(Boolean)
    let node = root
    parts.slice(0, -1).forEach(part => {
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, folders: new Map(), files: [] })
      node = node.folders.get(part)
    })
    node.files.push({ ...change, name: parts.at(-1), path: change.file })
  }
  return root
}

function SelectionBox({ checked, indeterminate, onChange }) {
  const ref = React.useRef(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate }, [indeterminate])
  return <input ref={ref} className="selection-box" type="checkbox" checked={checked} onChange={onChange} onClick={event => event.stopPropagation()} />
}

function App() {
  const [directory, setDirectory] = useState('')
  const [files, setFiles] = useState([])
  const [changes, setChanges] = useState([])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [expanded, setExpanded] = useState(new Set(['']))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectModal, setProjectModal] = useState(false)
  const [projectDraft, setProjectDraft] = useState({ path: '', name: '', icon: null })
  const [settings, setSettings] = useState({ endpoint: 'http://localhost:11434', model: '', language: 'English' })
  const [models, setModels] = useState([])
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMessage, setAiMessage] = useState('')
  const [aiError, setAiError] = useState('')
  const [projects, setProjects] = useState([])
  const [gitBusy, setGitBusy] = useState(false)
  const [pushPending, setPushPending] = useState(false)
  const [errorModal, setErrorModal] = useState('')
  const [diffModal, setDiffModal] = useState(null)
  const [view, setView] = useState('changes')
  const [stashes, setStashes] = useState([])
  const [loading, setLoading] = useState('')
  const [projectIcon, setProjectIcon] = useState(null)
  const [pendingOperation, setPendingOperation] = useState('commit')
  const [lastEvent, setLastEvent] = useState('Waiting for a directory')
  const tree = useMemo(() => buildTree(changes), [changes])
  const visibleChanges = useMemo(() => changes.filter(c => c.file.toLowerCase().includes(query.toLowerCase())), [changes, query])
  const allPaths = visibleChanges.map(change => change.file)
  const allSelected = allPaths.length > 0 && allPaths.every(path => selected.has(path))
  const allPartial = allPaths.some(path => selected.has(path)) && !allSelected

  useEffect(() => { window.directoryAPI.getSettings().then(setSettings); window.directoryAPI.getProjects().then(result => setProjects(normalizeProjects(result))); window.directoryAPI.onOpenSettings(() => setSettingsOpen(true)); return undefined }, [])
  useEffect(() => { window.directoryAPI.onUpdate(data => {
    setFiles(data.files || [])
    setChanges(data.changes || [])
    setPushPending(Boolean(data.pushPending))
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
  useEffect(() => { if (projectModal && projectDraft.path) window.directoryAPI.getProjectIcon(projectDraft.path).then(icon => setProjectDraft(value => value.path === projectDraft.path && !value.icon ? { ...value, icon } : value)).catch(() => {}) }, [projectModal, projectDraft.path])
  async function choose() { setProjectDraft({ path: '', name: '', icon: null }); setProjectModal(true) }
  async function browseProjectPath() { const selected = await window.directoryAPI.chooseDirectory(); if (selected) { const icon = await window.directoryAPI.getProjectIcon(selected); setProjectDraft(value => ({ ...value, path: selected, name: value.name || projectName({ path: selected }), icon })) } }
  async function browseProjectIcon() { const icon = await window.directoryAPI.chooseProjectIcon(); if (icon) setProjectDraft(value => ({ ...value, icon })) }
  async function saveProject() { if (!projectDraft.path) return; setLoading('Loading project…'); try { await window.directoryAPI.startWatching(projectDraft.path); setProjects(normalizeProjects(await window.directoryAPI.addProject({ ...projectDraft, name: projectDraft.name.trim() || projectName({ path: projectDraft.path }) }))); setProjectModal(false); setView('changes') } catch (error) { setErrorModal(error.message) } finally { setLoading('') } }
  async function selectProject(option) { if (option?.value) { setLoading('Loading project…'); try { await window.directoryAPI.startWatching(option.value) } catch (error) { setErrorModal(error.message) } finally { setLoading('') } } }
  async function openHomeProject(project) { setView('changes'); await selectProject({ value: project.path }) }
  async function removeProjectOption(option) { if (!option || !window.confirm(`Remove "${option.value}" from the project list?\nNo files will be deleted.`)) return; setProjects(normalizeProjects(await window.directoryAPI.removeProject(option.value))); if (directory === option.value) { await window.directoryAPI.stopWatching(); setDirectory(''); setActive(false); setFiles([]); setChanges([]) } }
  async function resume() { if (directory) { setLoading('Starting monitor…'); try { await window.directoryAPI.startWatching(directory) } finally { setLoading('') } } }
  async function stop() { await window.directoryAPI.stopWatching(); setActive(false); setFiles([]); setChanges([]); setSelected(new Set()); setLastEvent('Monitor stopped') }
  function toggleFolder(path) { setExpanded(value => { const next = new Set(value); next.has(path) ? next.delete(path) : next.add(path); return next }) }
  function toggleSelection(paths) { setSelected(value => { const next = new Set(value); const all = paths.every(path => next.has(path)); paths.forEach(path => all ? next.delete(path) : next.add(path)); return next }) }
  async function loadModels() { setAiError(''); try { const result = await window.directoryAPI.fetchModels(settings.endpoint); setModels(result); if (!settings.model && result[0]) setSettings(value => ({ ...value, model: result[0] })) } catch (error) { setAiError(error.message) } }
  async function saveAiSettings() { setAiError(''); try { await window.directoryAPI.saveSettings(settings); setSettingsOpen(false) } catch (error) { setErrorModal(error.message) } }
  async function generateCommitMessage(operation = 'commit') { setPendingOperation(operation); setAiBusy(true); setLoading('Generating commit message…'); setAiError(''); try { setAiMessage(await window.directoryAPI.generateCommitMessage([...selected])) } catch (error) { setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false); setLoading('') } }
  async function openDiff(file) { try { setDiffModal({ file, diff: await window.directoryAPI.getDiff(file) }) } catch (error) { setErrorModal(error.message) } }
  async function commitSelected() { setAiBusy(true); setLoading('Creating commit…'); setAiError(''); try { await window.directoryAPI.commitSelected([...selected], aiMessage); setAiMessage(''); setSelected(new Set()); setLastEvent('Commit completed'); await window.directoryAPI.refresh() } catch (error) { setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false); setLoading('') } }
  async function stashSelected() { setAiBusy(true); setLoading('Creating stash…'); setAiError(''); try { await window.directoryAPI.stashSelected([...selected], aiMessage); setAiMessage(''); setSelected(new Set()); setLastEvent('Stash created'); await window.directoryAPI.refresh(); setStashes(await window.directoryAPI.getStashes()) } catch (error) { setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false); setLoading('') } }
  async function runGitRemote(action) { setGitBusy(true); setLoading(`${action === 'push' ? 'Pushing changes…' : 'Pulling changes…'}`); try { const result = action === 'pull' ? await window.directoryAPI.gitPull() : await window.directoryAPI.gitPush(); setLastEvent(result || `${action === 'push' ? 'Push' : 'Pull'} completed`); await window.directoryAPI.refresh() } catch (error) { setErrorModal(error.message) } finally { setGitBusy(false); setLoading('') } }
  function renderTree(node, depth = 0) {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
    const filesInNode = node.files.filter(file => file.file.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name))
    const branchPaths = [...node.files.map(file => file.path), ...[...node.folders.values()].flatMap(folder => { const collect = n => [...n.files.map(file => file.path), ...[...n.folders.values()].flatMap(collect)]; return collect(folder) })]
    const selectedCount = branchPaths.filter(path => selected.has(path)).length
    const branchChecked = branchPaths.length > 0 && selectedCount === branchPaths.length
    const branchPartial = selectedCount > 0 && !branchChecked
    return <>
      {node.path && <div className="tree-row folder" style={{ paddingLeft: `${18 + depth * 20}px` }} onClick={() => toggleFolder(node.path)}><SelectionBox checked={branchChecked} indeterminate={branchPartial} onChange={() => toggleSelection(branchPaths)} /><span className="twisty">{expanded.has(node.path) ? '▾' : '▸'}</span><span className="folder-icon">▰</span><span className="tree-name">{node.name}</span></div>}
      {(!node.path || expanded.has(node.path)) && <>{folders.map(folder => <React.Fragment key={folder.path}>{renderTree(folder, depth + 1)}</React.Fragment>)}{filesInNode.map(file => <div className={`tree-row tree-file ${selected.has(file.path) ? 'selected' : ''} ${file.status === 'Modified' ? 'diffable' : ''}`} style={{ paddingLeft: `${40 + depth * 20}px` }} key={file.path} onClick={() => file.status === 'Modified' && openDiff(file.path)}><SelectionBox checked={selected.has(file.path)} onChange={() => toggleSelection([file.path])} /><span className="file-icon">▤</span><span className="tree-name">{file.name}</span><span className={`change ${file.status === 'Added' ? 'added' : file.status === 'Deleted' ? 'deleted' : ''}`}>{file.status}</span><span className="git-code">{file.code}</span></div>)}</>}
    </>
  }

  return <main>
    <aside><div className="brand"><span className="brand-mark">✦</span><div><strong>Pulse</strong><small>GIT AI</small></div></div><div className="side-label">HOME</div><div className={`nav ${view === 'home' ? 'active' : ''}`} onClick={() => setView('home')}><i className="nav-icon home-nav-icon" /><span>Home</span></div><div className="side-label monitor-label">MONITOR</div><div className={`nav ${view === 'changes' ? 'active' : ''}`} onClick={() => setView('changes')}><i className="nav-icon changes-nav-icon" /><span>File changes</span></div><div className={`nav ${view === 'stash' ? 'active' : ''}`} onClick={() => setView('stash')}><i className="nav-icon stash-nav-icon" /><span>Stash</span></div><div className="side-footer">Electron desktop<br /><span>v1.0.0 · ready</span></div></aside>
    <section className="content">{view === 'home' ? <div className="home-page"><header><div><p className="eyebrow">WORKSPACE / HOME</p><h1>Projects</h1><p className="muted">Open one of your saved Git repositories.</p></div></header><div className="home-project-grid"><button className="home-project-card new-project-card" onClick={choose}><span className="new-project-icon">＋</span><span>New project</span><small>Choose a directory</small></button>{projects.length ? projects.map(project => <button className={`home-project-card ${project.path === directory ? 'active' : ''}`} key={project.path} title={project.path} onClick={() => openHomeProject(project)}><img src={project.icon || defaultPathIcon} alt="" /><span>{projectName(project)}</span><small>Open project</small></button>) : null}</div></div> : <><header><div><p className="eyebrow">WORKSPACE / MONITOR</p><h1>Directory watcher</h1><p className="muted">Monitor file changes in real time from the shell.</p></div><div className={`status ${active ? 'online' : ''}`}><i />{active ? 'WATCHING' : 'IDLE'}</div></header>
      {view === 'changes' ? <>
      <div className="toolbar"><div className="path project-picker">{directory && <button className="folder-button" title="Open in file browser" onClick={() => window.directoryAPI.openInExplorer()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2H20a1.5 1.5 0 0 1 1.5 1.5v7.5A1.5 1.5 0 0 1 20 19H4a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 4 6.5Z" /></svg></button>}<Select className="project-react-select" classNamePrefix="project-select" isClearable={false} placeholder="Recent projects…" value={(() => { const project = projects.find(item => item.path === directory); return project ? { value: project.path, label: project.path, icon: project.icon || defaultPathIcon } : null })()} options={projects.map(project => ({ value: project.path, label: project.path, icon: project.icon || defaultPathIcon }))} onChange={selectProject} menuPortalTarget={document.body} components={{ SingleValue: projectValue => <components.SingleValue {...projectValue}><span className="project-single-value"><img src={projectValue.data.icon || defaultPathIcon} alt="" />{projectValue.data.label}</span></components.SingleValue>, Option: projectOption => <components.Option {...projectOption}><span className="project-option-label"><img src={projectOption.data.icon || defaultPathIcon} alt="" />{projectOption.data.label}</span><button className="project-remove" title="Remove project" onClick={event => { event.stopPropagation(); removeProjectOption(projectOption.data) }}>×</button></components.Option> }} styles={{ container: base => ({ ...base, flex: 1, minWidth: 0 }), control: base => ({ ...base, background: 'transparent', border: 0, boxShadow: 'none', minHeight: 30 }), valueContainer: base => ({ ...base, padding: 0 }), indicatorsContainer: base => ({ ...base, padding: 0 }), menuPortal: base => ({ ...base, zIndex: 100 }), menu: base => ({ ...base, background: '#24272a', color: '#f3f4f6' }), menuList: base => ({ ...base, background: '#24272a', padding: 4 }), option: (base, state) => ({ ...base, background: state.isFocused ? '#343a3f' : '#24272a', color: '#f3f4f6', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }) }} /></div><button className="primary" onClick={choose}>＋ Choose directory</button>{active ? <button className="ghost" onClick={stop}>Stop</button> : directory && <button className="ghost" onClick={resume}>Start</button>}</div>
      <div className="stats"><div><span>MONITORED FILES</span><b>{files.length}</b></div><div><span>LAST EVENT</span><b>{lastEvent}</b></div><div className="git-actions"><span>REPOSITORY</span><div><button className="git-button commit-button" disabled={!selected.size || aiBusy} onClick={generateCommitMessage}>{aiBusy ? 'Generating…' : '✦ Commit'}</button><button className="git-button" disabled={!directory || gitBusy} onClick={() => runGitRemote('pull')}>↓ Pull</button><button className="git-button" disabled={!directory || gitBusy} onClick={() => runGitRemote('push')}>↑ Push</button></div></div></div>
      <div className="panel"><div className="panel-head"><div><h2>Changes to commit</h2><p>{visibleChanges.length} Git files · {selected.size} selected</p></div><div className="panel-actions"><input placeholder="Search files..." value={query} onChange={e => setQuery(e.target.value)} /></div></div><div className="tree-head"><span className="head-selection"><SelectionBox checked={allSelected} indeterminate={allPartial} onChange={() => toggleSelection(allPaths)} /> FILE / DIRECTORY</span><span>STATUS</span><span>CODE</span></div>{changes.length ? renderTree(tree) : <div className="empty"><div>✓</div><h3>Working tree clean</h3><p>No added, deleted, or modified files to commit.</p>{pushPending && <button className="push-cta" disabled={gitBusy} onClick={() => runGitRemote('push')}>↑ Push local commits</button>}</div>}</div>
      </> : <div className="stash-view">{directory && <div className="stash-path">⌂ {directory}</div>}<div className="stash-heading"><div><h2>Stash</h2><p className="muted">Pending changes and files stored in Git stashes.</p></div><button className="ai-button" disabled={!selected.size || aiBusy} onClick={() => generateCommitMessage('stash')}>{aiBusy ? 'Generating…' : '✦ Stash'}</button></div>{directory && changes.length > 0 && <div className="stash-pending"><div className="stash-section-title"><strong>Pending changes</strong><span>{selected.size} selected</span></div><div className="tree-head"><span className="head-selection"><SelectionBox checked={allSelected} indeterminate={allPartial} onChange={() => toggleSelection(allPaths)} /> FILE / DIRECTORY</span><span>STATUS</span><span>CODE</span></div>{renderTree(tree)}</div>}{!directory ? <div className="empty"><div>—</div><h3>No project selected</h3><p>Select a project to view its stashes.</p></div> : !stashes.length ? <div className="empty"><div>✓</div><h3>No stashes</h3><p>This project has no stored stashes.</p></div> : stashes.map(stash => <div className="stash-card" key={stash.ref}><div className="stash-card-head"><strong>{stash.ref}</strong><span>{stash.date}</span></div><p>{stash.message || 'Unnamed stash'}</p><div className="stash-files">{stash.files.map(file => <div key={file}>▤ {file}</div>)}</div></div>)}</div>}
      </>} {loading && <div className="loading-backdrop"><div className="loader-card"><span className="spinner" /><strong>{loading}</strong></div></div>}
      {projectModal && <div className="modal-backdrop" onClick={() => setProjectModal(false)}><div className="modal project-modal" onClick={event => event.stopPropagation()}><h2>New project</h2><p className="muted">Set the repository path and customize its name and icon.</p><label>Project path<div className="project-path-input"><input value={projectDraft.path} onChange={event => setProjectDraft({ ...projectDraft, path: event.target.value })} placeholder="C:\\Projects\\MyRepository" /><button className="ghost" onClick={browseProjectPath}>Browse</button></div></label>{projectDraft.path && <div className="project-preview"><img src={projectDraft.icon || defaultPathIcon} alt="Project icon" /><div><strong>{projectDraft.name || projectName({ path: projectDraft.path })}</strong><small>{projectDraft.icon ? 'Custom icon' : 'Icon found in project or default icon'}</small></div><button className="ghost" onClick={browseProjectIcon}>Choose file</button></div>}<label>Project name<input value={projectDraft.name} onChange={event => setProjectDraft({ ...projectDraft, name: event.target.value })} placeholder="Project name" /></label><div className="modal-actions"><button className="ghost" onClick={() => setProjectModal(false)}>Cancel</button><button className="primary" disabled={!projectDraft.path} onClick={saveProject}>Open project</button></div></div></div>}
      {errorModal && <div className="modal-backdrop" onClick={() => setErrorModal('')}><div className="modal error-modal" onClick={event => event.stopPropagation()}><h2>Error</h2><pre>{errorModal}</pre><div className="modal-actions"><button className="primary" onClick={() => setErrorModal('')}>Close</button></div></div></div>}
      {diffModal && <div className="modal-backdrop" onClick={() => setDiffModal(null)}><div className="modal diff-modal" onClick={event => event.stopPropagation()}><h2>Diff</h2><p className="muted">{diffModal.file}</p><pre>{diffModal.diff}</pre><div className="modal-actions"><button className="primary" onClick={() => setDiffModal(null)}>Close</button></div></div></div>}
      {(settingsOpen || aiMessage || aiError) && <div className="modal-backdrop" onClick={() => { if (!aiBusy) { setSettingsOpen(false); setAiMessage(''); setAiError('') } }}><div className="modal" onClick={event => event.stopPropagation()}>{settingsOpen ? <><h2>AI Settings</h2><p className="muted">Configure Ollama to generate commit messages.</p><label>Ollama endpoint<input value={settings.endpoint} onChange={event => setSettings({ ...settings, endpoint: event.target.value })} /></label><label>Model<select value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value })}><option value="">Select a model</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</select></label><label>Message language<select value={settings.language} onChange={event => setSettings({ ...settings, language: event.target.value })}>{['English', 'Italian', 'Spanish', 'French', 'German', 'Portuguese', 'Chinese', 'Japanese'].map(language => <option key={language} value={language}>{language}</option>)}</select></label><div className="modal-actions"><button className="ghost" onClick={loadModels}>Load models</button><button className="primary" onClick={saveAiSettings}>Save</button></div>{aiError && <p className="modal-error">{aiError}</p>}</> : <><h2>{pendingOperation === 'stash' ? 'Stash message' : 'Commit message'}</h2><textarea value={aiMessage} onChange={event => setAiMessage(event.target.value)} /><div className="modal-actions"><button className="ghost" onClick={() => { setAiMessage(''); setAiError('') }}>Close</button>{aiError && <button className="ghost" onClick={() => generateCommitMessage(pendingOperation)} disabled={aiBusy}>{aiBusy ? 'Retrying…' : 'Retry'}</button>}{pendingOperation === 'stash' ? <button className="primary" onClick={stashSelected} disabled={aiBusy || !aiMessage.trim()}>Stash</button> : <button className="primary" onClick={commitSelected} disabled={aiBusy || !aiMessage.trim()}>Commit</button>}</div></>}</div></div>}
    </section>
  </main>
}
createRoot(document.getElementById('root')).render(<App />)
