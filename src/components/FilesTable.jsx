import React, { useEffect, useMemo, useState } from 'react'
import FileIcon from './FileIcon'

// Pills read left to right in the order a working tree usually grows; statuses a
// caller invents (LFS "Tracked", stash "Stashed") sort in after them.
const STATUS_ORDER = ['Modified', 'Added', 'Deleted']
const statusRank = status => { const rank = STATUS_ORDER.indexOf(status); return rank === -1 ? STATUS_ORDER.length : rank }
const statusTone = status => status === 'Added' ? 'added' : status === 'Deleted' ? 'deleted' : ''

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
  function collapse(node) {
    for (const child of node.folders.values()) collapse(child)
    while (node.files.length === 0 && node.folders.size === 1) {
      const child = [...node.folders.values()][0]
      node.name = node.name && node.name !== '.' ? `${node.name}/${child.name}` : child.name
      node.path = child.path
      node.folders = child.folders
      node.files = child.files
    }
  }
  collapse(root)
  return root
}

function SelectionBox({ checked, indeterminate, onChange }) {
  return <button type="button" className={`selection-switch ${checked ? 'enabled' : ''} ${indeterminate ? 'indeterminate' : ''}`} role="switch" aria-checked={indeterminate ? 'mixed' : checked} aria-label={checked ? 'Deselect' : 'Select'} onClick={event => { event.stopPropagation(); onChange() }}><span /></button>
}

function FilesTable({ changes, fileIndexing, query, onQueryChange, selected, expanded, toggleFolder, toggleSelection, expandAllFolders, collapseAllFolders, openDiff, addGitignoreEntry, addGitignoreSelection, variant = 'changes', title = 'Changes to commit', emptyMessage = 'No added, deleted, or modified files to commit.', outgoingCommits = 0, gitBusy, runGitRemote, compact = false, readOnly = false }) {
  const tree = useMemo(() => buildTree(changes), [changes])
  const [hiddenStatuses, setHiddenStatuses] = useState(() => new Set())
  const [contextMenu, setContextMenu] = useState(null)
  const [selectedFolderPaths, setSelectedFolderPaths] = useState(() => new Set())
  const [selectedFolderCoverage, setSelectedFolderCoverage] = useState(() => new Map())
  const matchesQuery = change => change.file.toLowerCase().includes(query.toLowerCase())
  const isVisible = change => matchesQuery(change) && !hiddenStatuses.has(change.status)
  // Counts deliberately ignore the status filter, so a pill never reports zero for itself.
  const statusCounts = useMemo(() => [...changes.filter(matchesQuery).reduce((counts, change) => counts.set(change.status, (counts.get(change.status) || 0) + 1), new Map())].sort((a, b) => statusRank(a[0]) - statusRank(b[0]) || a[0].localeCompare(b[0])), [changes, query])
  const visibleChanges = changes.filter(isVisible)
  const allPaths = visibleChanges.map(change => change.file)
  const allSelected = allPaths.length > 0 && allPaths.every(path => selected.has(path))
  const allPartial = allPaths.some(path => selected.has(path)) && !allSelected
  const folderPaths = useMemo(() => { const paths = []; const collect = node => { for (const folder of node.folders.values()) { paths.push(folder.path); collect(folder) } }; collect(tree); return paths }, [tree])
  const allFoldersExpanded = folderPaths.length > 0 && folderPaths.every(path => expanded.has(path))
  const someFolderExpanded = folderPaths.some(path => expanded.has(path))

  useEffect(() => {
    if (!contextMenu) return undefined
    const close = () => setContextMenu(null)
    const closeOnKey = event => { if (event.key === 'Escape') close() }
    document.addEventListener('click', close)
    document.addEventListener('scroll', close, true)
    document.addEventListener('keydown', closeOnKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', closeOnKey)
    }
  }, [contextMenu])

  function openContextMenu(event, item) {
    event.preventDefault()
    event.stopPropagation()
    const extension = item.type === 'file' ? (() => {
      const name = item.name || ''
      const dot = name.lastIndexOf('.')
      return dot > 0 && dot < name.length - 1 ? name.slice(dot) : ''
    })() : ''
    const selectionEntries = getSelectionIgnoreEntries()
    const selectedForIgnore = selectionEntries.length > 0
    const menuHeight = 75 + (extension ? 40 : 0) + (selectedForIgnore ? 40 : 0)
    setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 250), y: Math.min(event.clientY, window.innerHeight - menuHeight), ...item, extension, selectedForIgnore, selectionEntries })
  }

  function toggleStatus(status) {
    setHiddenStatuses(current => { const next = new Set(current); if (!next.delete(status)) next.add(status); return next })
  }

  function toggleAllSelection(paths) {
    setSelectedFolderPaths(new Set())
    setSelectedFolderCoverage(new Map())
    toggleSelection(paths)
  }

  function toggleFileSelection(path) {
    if (selected.has(path)) {
      const normalizedPath = path.replaceAll('\\', '/')
      setSelectedFolderPaths(current => new Set([...current].filter(folder => {
        const normalizedFolder = folder.replaceAll('\\', '/')
        return normalizedPath !== normalizedFolder && !normalizedPath.startsWith(`${normalizedFolder}/`)
      })))
      setSelectedFolderCoverage(current => new Map([...current].filter(([folder]) => {
        const normalizedFolder = folder.replaceAll('\\', '/')
        return normalizedPath !== normalizedFolder && !normalizedPath.startsWith(`${normalizedFolder}/`)
      })))
    }
    toggleSelection([path])
  }

  function toggleFolderSelection(path, paths) {
    const allSelected = paths.length > 0 && paths.every(filePath => selected.has(filePath))
    setSelectedFolderPaths(current => {
      const next = new Set(current)
      if (allSelected) next.delete(path)
      else next.add(path)
      return next
    })
    setSelectedFolderCoverage(current => {
      const next = new Map(current)
      if (allSelected) next.delete(path)
      else next.set(path, paths.slice())
      return next
    })
    toggleSelection(paths)
  }

  function visiblePaths(node) {
    return [...node.files.filter(isVisible).map(file => file.path), ...[...node.folders.values()].flatMap(visiblePaths)]
  }

  function findNode(node, path) {
    if (node.path === path) return node
    for (const folder of node.folders.values()) {
      const match = findNode(folder, path)
      if (match) return match
    }
    return null
  }

  function allNodePaths(node) {
    return [...node.files.map(file => file.path), ...[...node.folders.values()].flatMap(allNodePaths)]
  }

  function getSelectionIgnoreEntries() {
    const normalizedSelected = new Set([...selected].map(value => value.replaceAll('\\', '/')))
    const explicitFolders = [...selectedFolderPaths]
    const folderCandidates = [...new Set([...explicitFolders, ...folderPaths])]
    const completeFolders = folderCandidates.filter(folder => {
      const node = findNode(tree, folder)
      const paths = selectedFolderCoverage.get(folder) || (node ? allNodePaths(node) : [])
      return paths.length > 0 && paths.every(value => normalizedSelected.has(value.replaceAll('\\', '/')))
    })
    // Explicit folder selections win over folders inferred from a complete set
    // of file checkboxes. A partial parent is never promoted to a folder rule.
    const preferredFolders = completeFolders.filter(folder => explicitFolders.includes(folder)).length > 0
      ? completeFolders.filter(folder => explicitFolders.includes(folder))
      : completeFolders
    const normalizedFolders = preferredFolders.map(folder => folder.replaceAll('\\', '/'))
    const ignoreFolders = preferredFolders.filter(folder => {
      const normalizedFolder = folder.replaceAll('\\', '/')
      return !normalizedFolders.some(other => other !== normalizedFolder && normalizedFolder.startsWith(`${other}/`))
    })
    const folders = ignoreFolders.map(value => ({ kind: 'folder', value }))
    const files = [...selected].filter(value => {
      const normalizedValue = value.replaceAll('\\', '/')
      return !ignoreFolders.some(folder => { const normalizedFolder = folder.replaceAll('\\', '/'); return normalizedValue === normalizedFolder || normalizedValue.startsWith(`${normalizedFolder}/`) })
    }).map(value => ({ kind: 'file', value }))
    return [...folders, ...files]
  }

  function renderTree(node, depth = 0) {
    // Folder rows aggregate only what is on screen, so a branch that is entirely
    // filtered out leaves no empty row behind and its switch cannot reach into it.
    const branchPaths = visiblePaths(node)
    if (node.path && branchPaths.length === 0) return null
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
    const filesInNode = node.files.filter(isVisible).sort((a, b) => a.name.localeCompare(b.name))
    const selectedCount = branchPaths.filter(path => selected.has(path)).length
    const branchChecked = branchPaths.length > 0 && selectedCount === branchPaths.length
    const branchPartial = selectedCount > 0 && !branchChecked
    // The virtual root draws no row of its own, so its children stay at the caller's depth.
    const childDepth = node.path ? depth + 1 : depth
    return <>
      {node.path && <div className="tree-row folder" style={{ '--depth': depth }} onClick={() => toggleFolder(node.path)} onContextMenu={event => openContextMenu(event, { type: 'folder', path: node.path, name: node.name, selectedPaths: branchPaths })}><SelectionBox checked={branchChecked} indeterminate={branchPartial} onChange={() => toggleFolderSelection(node.path, branchPaths)} /><span className="twisty">{expanded.has(node.path) ? '▾' : '▸'}</span><span className="folder-icon" /><span className="tree-name">{node.name}</span></div>}
      {(!node.path || expanded.has(node.path)) && <>{folders.map(folder => <React.Fragment key={folder.path}>{renderTree(folder, childDepth)}</React.Fragment>)}{filesInNode.map(file => <div className={`tree-row tree-file ${selected.has(file.path) ? 'selected' : ''} ${file.status === 'Modified' ? 'diffable' : ''}`} style={{ '--depth': childDepth }} key={file.path} onClick={() => file.status === 'Modified' && openDiff(file.path)} onContextMenu={event => openContextMenu(event, { type: 'file', path: file.path, name: file.name })}><SelectionBox checked={selected.has(file.path)} onChange={() => toggleFileSelection(file.path)} /><FileIcon path={file.path} /><span className="tree-name">{file.name}</span><span className={`change-pill ${statusTone(file.status)}`}>{file.status}</span></div>)}</>}
    </>
  }

  const statusFilters = statusCounts.length > 0 && <span className="head-status-filters">{statusCounts.map(([status, count]) => { const on = !hiddenStatuses.has(status); return <button key={status} type="button" className={`change-pill filter-pill ${statusTone(status)} ${on ? '' : 'off'}`} aria-pressed={on} title={on ? `Hide ${status.toLowerCase()} files` : `Show ${status.toLowerCase()} files`} onClick={() => toggleStatus(status)}>{status}<b>{count}</b></button> })}</span>
  const expansionActions = <div className="tree-expansion-actions"><button className="ghost expansion-icon-button" title="Expand all folders" aria-label="Expand all folders" disabled={!expandAllFolders || folderPaths.length === 0 || allFoldersExpanded} onClick={expandAllFolders}><span className="chevron-icon chevron-down" /></button><button className="ghost expansion-icon-button" title="Collapse all folders" aria-label="Collapse all folders" disabled={!collapseAllFolders || folderPaths.length === 0 || !someFolderExpanded} onClick={collapseAllFolders}><span className="chevron-icon chevron-up" /></button></div>
  const selectedIgnoreTarget = getSelectionIgnoreEntries()
  const header = <div className="tree-head"><span className="head-selection"><SelectionBox checked={allSelected} indeterminate={allPartial} onChange={() => toggleAllSelection(allPaths)} /> FILE / DIRECTORY</span>{statusFilters}{expansionActions}</div>
  const body = changes.length ? <>{header}{renderTree(tree)}</> : <div className="empty"><div>✓</div><h3>{variant === 'changes' ? 'Working tree clean' : 'No pending changes'}</h3><p>{emptyMessage}</p>{variant === 'changes' && outgoingCommits > 0 && <button className="push-cta" disabled={gitBusy || outgoingCommits < 1} onClick={() => runGitRemote('push')}>↑ Push local commits ({outgoingCommits})</button>}</div>

  return (
    <div className={`panel file-changes-panel ${variant === 'stash' ? 'stash-panel' : ''} ${compact ? 'compact-files-panel' : ''} ${readOnly ? 'read-only-files-panel' : ''}`}>
      <div className="panel-head">
        <div>
          <h2>{variant === 'stash' ? 'Pending changes' : title}</h2>
          <p>{visibleChanges.length} Git files{readOnly ? '' : ` · ${selected.size} selected`}{fileIndexing?.status === 'indexing' ? ' · Indexing files…' : ''}</p>
        </div>
        <div className="panel-actions">
          <input placeholder="Search files..." value={query} onChange={event => onQueryChange(event.target.value)} />
        </div>
      </div>
      {body}
      {contextMenu && addGitignoreEntry && <div className="file-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={event => event.stopPropagation()}><button type="button" onClick={() => { setContextMenu(null); addGitignoreEntry(contextMenu.type, contextMenu.path) }}>Ignore this {contextMenu.type}</button>{contextMenu.extension && <button type="button" onClick={() => { setContextMenu(null); addGitignoreEntry('extension', contextMenu.extension) }}>Ignore {contextMenu.extension} files</button>}{contextMenu.selectedForIgnore && addGitignoreSelection && <button type="button" onClick={() => { setContextMenu(null); addGitignoreSelection(contextMenu.selectionEntries) }}>Ignore selected</button>}</div>}
    </div>
  )
}

// Operation state (loading/AI activity) changes at the App level, but it does
// not change this tree. Avoid rebuilding thousands of rows for every spinner
// tick or modal update in a large repository.
const sameFilesTableState = (previous, next) => previous.changes === next.changes && previous.selected === next.selected && previous.expanded === next.expanded && previous.query === next.query && previous.variant === next.variant && previous.title === next.title && previous.emptyMessage === next.emptyMessage && previous.outgoingCommits === next.outgoingCommits && previous.gitBusy === next.gitBusy && previous.compact === next.compact && previous.readOnly === next.readOnly && previous.fileIndexing?.status === next.fileIndexing?.status && previous.fileIndexing?.error === next.fileIndexing?.error

export default React.memo(FilesTable, sameFilesTableState)
