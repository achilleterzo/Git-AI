import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Select, { components } from 'react-select'
import './styles.css'

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
  const [settings, setSettings] = useState({ endpoint: 'http://localhost:11434', model: '', language: 'English' })
  const [models, setModels] = useState([])
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMessage, setAiMessage] = useState('')
  const [aiError, setAiError] = useState('')
  const [projects, setProjects] = useState([])
  const [gitBusy, setGitBusy] = useState(false)
  const [pushPending, setPushPending] = useState(false)
  const [errorModal, setErrorModal] = useState('')
  const [lastEvent, setLastEvent] = useState('Waiting for a directory')
  const tree = useMemo(() => buildTree(changes), [changes])
  const visibleChanges = useMemo(() => changes.filter(c => c.file.toLowerCase().includes(query.toLowerCase())), [changes, query])
  const allPaths = visibleChanges.map(change => change.file)
  const allSelected = allPaths.length > 0 && allPaths.every(path => selected.has(path))
  const allPartial = allPaths.some(path => selected.has(path)) && !allSelected

  useEffect(() => { window.directoryAPI.getSettings().then(setSettings); window.directoryAPI.getProjects().then(setProjects); window.directoryAPI.onOpenSettings(() => setSettingsOpen(true)); return undefined }, [])
  useEffect(() => window.directoryAPI.onUpdate(data => {
    setFiles(data.files || [])
    setChanges(data.changes || [])
    setPushPending(Boolean(data.pushPending))
    setDirectory(data.directory || '')
    setActive(true)
    if (data.gitOk) setSelected(previous => {
      const currentPaths = new Set((data.changes || []).map(change => change.file))
      return new Set([...previous].filter(path => currentPaths.has(path)))
    })
    if (data.error) setErrorModal(data.error)
    else if (['git-pull', 'git-push', 'post-commit'].includes(data.reason)) setLastEvent(data.reason === 'post-commit' ? 'Commit completed' : data.reason === 'git-push' ? 'Push completed' : 'Pull completed')
  }), [])
  async function choose() { const selected = await window.directoryAPI.chooseDirectory(); if (selected) { setProjects(await window.directoryAPI.addProject(selected)); await window.directoryAPI.startWatching(selected) } }
  async function selectProject(option) { if (option?.value) await window.directoryAPI.startWatching(option.value) }
  async function removeProjectOption(option) { if (!option || !window.confirm(`Remove "${option.value}" from the project list?\nNo files will be deleted.`)) return; setProjects(await window.directoryAPI.removeProject(option.value)); if (directory === option.value) { await window.directoryAPI.stopWatching(); setDirectory(''); setActive(false); setFiles([]); setChanges([]) } }
  async function resume() { if (directory) await window.directoryAPI.startWatching(directory) }
  async function removeProject() { if (!directory || !window.confirm(`Remove "${directory}" from the project list?\nNo files will be deleted.`)) return; setProjects(await window.directoryAPI.removeProject(directory)); await window.directoryAPI.stopWatching(); setDirectory(''); setActive(false); setFiles([]); setChanges([]) }
  async function stop() { await window.directoryAPI.stopWatching(); setActive(false); setFiles([]); setChanges([]); setSelected(new Set()); setLastEvent('Monitor stopped') }
  function toggleFolder(path) { setExpanded(value => { const next = new Set(value); next.has(path) ? next.delete(path) : next.add(path); return next }) }
  function toggleSelection(paths) { setSelected(value => { const next = new Set(value); const all = paths.every(path => next.has(path)); paths.forEach(path => all ? next.delete(path) : next.add(path)); return next }) }
  async function loadModels() { setAiError(''); try { const result = await window.directoryAPI.fetchModels(settings.endpoint); setModels(result); if (!settings.model && result[0]) setSettings(value => ({ ...value, model: result[0] })) } catch (error) { setAiError(error.message) } }
  async function saveAiSettings() { setAiError(''); try { await window.directoryAPI.saveSettings(settings); setSettingsOpen(false) } catch (error) { setErrorModal(error.message) } }
  async function generateCommitMessage() { setAiBusy(true); setAiError(''); try { setAiMessage(await window.directoryAPI.generateCommitMessage([...selected])) } catch (error) { setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false) } }
  async function commitSelected() { setAiBusy(true); setAiError(''); try { await window.directoryAPI.commitSelected([...selected], aiMessage); setAiMessage(''); setSelected(new Set()); setLastEvent('Commit completed'); await window.directoryAPI.refresh() } catch (error) { setAiError(error.message); setErrorModal(error.message) } finally { setAiBusy(false) } }
  async function runGitRemote(action) { setGitBusy(true); try { const result = action === 'pull' ? await window.directoryAPI.gitPull() : await window.directoryAPI.gitPush(); setLastEvent(result || `${action === 'push' ? 'Push' : 'Pull'} completed`); await window.directoryAPI.refresh() } catch (error) { setErrorModal(error.message) } finally { setGitBusy(false) } }
  function renderTree(node, depth = 0) {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
    const filesInNode = node.files.filter(file => file.file.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name))
    const branchPaths = [...node.files.map(file => file.path), ...[...node.folders.values()].flatMap(folder => { const collect = n => [...n.files.map(file => file.path), ...[...n.folders.values()].flatMap(collect)]; return collect(folder) })]
    const selectedCount = branchPaths.filter(path => selected.has(path)).length
    const branchChecked = branchPaths.length > 0 && selectedCount === branchPaths.length
    const branchPartial = selectedCount > 0 && !branchChecked
    return <>
      {node.path && <div className="tree-row folder" style={{ paddingLeft: `${18 + depth * 20}px` }} onClick={() => toggleFolder(node.path)}><SelectionBox checked={branchChecked} indeterminate={branchPartial} onChange={() => toggleSelection(branchPaths)} /><span className="twisty">{expanded.has(node.path) ? '▾' : '▸'}</span><span className="folder-icon">▰</span><span className="tree-name">{node.name}</span></div>}
      {(!node.path || expanded.has(node.path)) && <>{folders.map(folder => renderTree(folder, depth + 1))}{filesInNode.map(file => <div className={`tree-row tree-file ${selected.has(file.path) ? 'selected' : ''}`} style={{ paddingLeft: `${40 + depth * 20}px` }} key={file.path}><SelectionBox checked={selected.has(file.path)} onChange={() => toggleSelection([file.path])} /><span className="file-icon">▤</span><span className="tree-name">{file.name}</span><span className={`change ${file.status === 'Added' ? 'added' : file.status === 'Deleted' ? 'deleted' : ''}`}>{file.status}</span><span className="git-code">{file.code}</span></div>)}</>}
    </>
  }

  return <main>
    <aside><div className="brand"><span>◈</span><div><strong>Pulse</strong><small>GIT AI</small></div></div><div className="side-label">MONITOR</div><div className="nav active">▦ <span>File changes</span></div><div className="nav">⌁ <span>Shell activity</span></div><div className="side-footer">Electron desktop<br /><span>v1.0.0 · ready</span></div></aside>
    <section className="content"><header><div><p className="eyebrow">WORKSPACE / MONITOR</p><h1>Directory watcher</h1><p className="muted">Monitor file changes in real time from the shell.</p></div><div className={`status ${active ? 'online' : ''}`}><i />{active ? 'WATCHING' : 'IDLE'}</div></header>
      <div className="toolbar"><div className="path project-picker">⌂ <Select className="project-react-select" classNamePrefix="project-select" isClearable={false} placeholder="Recent projects…" value={projects.includes(directory) ? { value: directory, label: directory } : null} options={projects.map(project => ({ value: project, label: project }))} onChange={selectProject} menuPortalTarget={document.body} components={{ Option: projectOption => <components.Option {...projectOption}><span className="project-option-label">{projectOption.data.label}</span><button className="project-remove" title="Remove project" onClick={event => { event.stopPropagation(); removeProjectOption(projectOption.data) }}>×</button></components.Option> }} styles={{ container: base => ({ ...base, flex: 1, minWidth: 0 }), control: base => ({ ...base, background: 'transparent', border: 0, boxShadow: 'none', minHeight: 30 }), valueContainer: base => ({ ...base, padding: 0 }), indicatorsContainer: base => ({ ...base, padding: 0 }), menuPortal: base => ({ ...base, zIndex: 100 }), menu: base => ({ ...base, background: '#24272a' }), option: (base, state) => ({ ...base, background: state.isFocused ? '#343a3f' : 'transparent', color: '#e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }) }} /></div><button className="primary" onClick={choose}>＋ Choose directory</button>{active ? <button className="ghost" onClick={stop}>Stop</button> : directory && <button className="ghost" onClick={resume}>Start</button>}</div>
      <div className="stats"><div><span>MONITORED FILES</span><b>{files.length}</b></div><div><span>LAST EVENT</span><b>{lastEvent}</b></div><div className="git-actions"><span>REPOSITORY</span><div><button className="git-button commit-button" disabled={!selected.size || aiBusy} onClick={generateCommitMessage}>{aiBusy ? 'Generating…' : '✦ Commit'}</button><button className="git-button" disabled={!directory || gitBusy} onClick={() => runGitRemote('pull')}>↓ Pull</button><button className="git-button" disabled={!directory || gitBusy} onClick={() => runGitRemote('push')}>↑ Push</button></div></div></div>
      <div className="panel"><div className="panel-head"><div><h2>Changes to commit</h2><p>{visibleChanges.length} Git files · {selected.size} selected</p></div><div className="panel-actions"><input placeholder="Search files..." value={query} onChange={e => setQuery(e.target.value)} /></div></div><div className="tree-head"><span className="head-selection"><SelectionBox checked={allSelected} indeterminate={allPartial} onChange={() => toggleSelection(allPaths)} /> FILE / DIRECTORY</span><span>STATUS</span><span>CODE</span></div>{changes.length ? renderTree(tree) : <div className="empty"><div>✓</div><h3>Working tree clean</h3><p>No added, deleted, or modified files to commit.</p>{pushPending && <button className="push-cta" disabled={gitBusy} onClick={() => runGitRemote('push')}>↑ Push local commits</button>}</div>}</div>
      {errorModal && <div className="modal-backdrop" onClick={() => setErrorModal('')}><div className="modal error-modal" onClick={event => event.stopPropagation()}><h2>Error</h2><pre>{errorModal}</pre><div className="modal-actions"><button className="primary" onClick={() => setErrorModal('')}>Close</button></div></div></div>}
      {(settingsOpen || aiMessage || aiError) && <div className="modal-backdrop" onClick={() => { if (!aiBusy) { setSettingsOpen(false); setAiMessage(''); setAiError('') } }}><div className="modal" onClick={event => event.stopPropagation()}>{settingsOpen ? <><h2>AI Settings</h2><p className="muted">Configure Ollama to generate commit messages.</p><label>Ollama endpoint<input value={settings.endpoint} onChange={event => setSettings({ ...settings, endpoint: event.target.value })} /></label><label>Model<select value={settings.model} onChange={event => setSettings({ ...settings, model: event.target.value })}><option value="">Select a model</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</select></label><label>Message language<select value={settings.language} onChange={event => setSettings({ ...settings, language: event.target.value })}>{['English', 'Italian', 'Spanish', 'French', 'German', 'Portuguese', 'Chinese', 'Japanese'].map(language => <option key={language} value={language}>{language}</option>)}</select></label><div className="modal-actions"><button className="ghost" onClick={loadModels}>Load models</button><button className="primary" onClick={saveAiSettings}>Save</button></div>{aiError && <p className="modal-error">{aiError}</p>}</> : <><h2>Commit message</h2><textarea value={aiMessage} onChange={event => setAiMessage(event.target.value)} /><div className="modal-actions"><button className="ghost" onClick={() => { setAiMessage(''); setAiError('') }}>Close</button>{aiError && <button className="ghost" onClick={generateCommitMessage} disabled={aiBusy}>{aiBusy ? 'Retrying…' : 'Retry'}</button>}<button className="primary" onClick={commitSelected} disabled={aiBusy || !aiMessage.trim()}>Commit</button></div></>}</div></div>}
    </section>
  </main>
}
createRoot(document.getElementById('root')).render(<App />)
