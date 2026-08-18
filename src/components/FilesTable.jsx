import React, { useEffect, useMemo, useRef } from 'react'

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
  const ref = useRef(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate }, [indeterminate])
  return <input ref={ref} className="selection-box" type="checkbox" checked={checked} onChange={onChange} onClick={event => event.stopPropagation()} />
}

export default function FilesTable({ changes, query, onQueryChange, selected, expanded, toggleFolder, toggleSelection, openDiff, variant = 'changes', title = 'Changes to commit', emptyMessage = 'No added, deleted, or modified files to commit.', outgoingCommits = 0, gitBusy, runGitRemote, compact = false }) {
  const tree = useMemo(() => buildTree(changes), [changes])
  const visibleChanges = changes.filter(change => change.file.toLowerCase().includes(query.toLowerCase()))
  const allPaths = visibleChanges.map(change => change.file)
  const allSelected = allPaths.length > 0 && allPaths.every(path => selected.has(path))
  const allPartial = allPaths.some(path => selected.has(path)) && !allSelected

  function renderTree(node, depth = 0) {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
    const filesInNode = node.files.filter(file => file.file.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name))
    const branchPaths = [...node.files.map(file => file.path), ...[...node.folders.values()].flatMap(folder => { const collect = child => [...child.files.map(file => file.path), ...[...child.folders.values()].flatMap(collect)]; return collect(folder) })]
    const selectedCount = branchPaths.filter(path => selected.has(path)).length
    const branchChecked = branchPaths.length > 0 && selectedCount === branchPaths.length
    const branchPartial = selectedCount > 0 && !branchChecked
    return <>
      {node.path && <div className="tree-row folder" style={{ paddingLeft: `${18 + depth * 20}px` }} onClick={() => toggleFolder(node.path)}><SelectionBox checked={branchChecked} indeterminate={branchPartial} onChange={() => toggleSelection(branchPaths)} /><span className="twisty">{expanded.has(node.path) ? '▾' : '▸'}</span><span className="folder-icon">▰</span><span className="tree-name">{node.name}</span></div>}
      {(!node.path || expanded.has(node.path)) && <>{folders.map(folder => <React.Fragment key={folder.path}>{renderTree(folder, depth + 1)}</React.Fragment>)}{filesInNode.map(file => <div className={`tree-row tree-file ${selected.has(file.path) ? 'selected' : ''} ${file.status === 'Modified' ? 'diffable' : ''}`} style={{ paddingLeft: `${40 + depth * 20}px` }} key={file.path} onClick={() => file.status === 'Modified' && openDiff(file.path)}><SelectionBox checked={selected.has(file.path)} onChange={() => toggleSelection([file.path])} /><span className="file-icon">▤</span><span className="tree-name">{file.name}</span><span className={`change ${file.status === 'Added' ? 'added' : file.status === 'Deleted' ? 'deleted' : ''}`}>{file.status}</span><span className="git-code">{file.code}</span></div>)}</>}
    </>
  }

  const header = <div className="tree-head"><span className="head-selection"><SelectionBox checked={allSelected} indeterminate={allPartial} onChange={() => toggleSelection(allPaths)} /> FILE / DIRECTORY</span><span>STATUS</span><span>CODE</span></div>
  const body = changes.length ? <>{header}{renderTree(tree)}</> : <div className="empty"><div>✓</div><h3>{variant === 'changes' ? 'Working tree clean' : 'No pending changes'}</h3><p>{emptyMessage}</p>{variant === 'changes' && outgoingCommits > 0 && <button className="push-cta" disabled={gitBusy || outgoingCommits < 1} onClick={() => runGitRemote('push')}>↑ Push local commits ({outgoingCommits})</button>}</div>

  return (
    <div className={`panel file-changes-panel ${variant === 'stash' ? 'stash-panel' : ''} ${compact ? 'compact-files-panel' : ''}`}>
      <div className="panel-head">
        <div>
          <h2>{variant === 'stash' ? 'Pending changes' : title}</h2>
          <p>{visibleChanges.length} Git files · {selected.size} selected</p>
        </div>
        <div className="panel-actions">
          <input placeholder="Search files..." value={query} onChange={event => onQueryChange(event.target.value)} />
        </div>
      </div>
      {body}
    </div>
  )
}
