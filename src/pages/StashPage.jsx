import { useState } from 'react'
import ProjectToolbar from '../components/ProjectToolbar'
import RepositoryActionsBar from '../components/RepositoryActionsBar'
import FilesTable from '../components/FilesTable'

export default function StashPage({ directory, projects, choose, selectProject, removeProjectOption, active, stop, resume, defaultPathIcon, currentBranch, gitLfs, onBranchSwitch, incomingCommits, outgoingCommits, selected, aiBusy, gitBusy, generateCommitMessage, generateStashMergeMessage, mergeStashes, runGitRemote, requestPush, requestDeleteStash, selectedStashes, restoreStash, changes, query, setQuery, expanded, toggleFolder, toggleSelection, openDiff, stashes, setSelectedStashes, expandedStashRef, setExpandedStashRef }) {
  const [stashFileSelected, setStashFileSelected] = useState(new Set())
  const [stashFileExpanded, setStashFileExpanded] = useState(new Set(['']))

  function toggleStashFolder(path) {
    setStashFileExpanded(value => {
      const next = new Set(value)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  function toggleStashSelection(paths) {
    setStashFileSelected(value => {
      const next = new Set(value)
      const allSelected = paths.every(path => next.has(path))
      paths.forEach(path => allSelected ? next.delete(path) : next.add(path))
      return next
    })
  }

  async function restoreSelectedStash() {
    await restoreStash({ partialRef: expandedStashRef, files: [...stashFileSelected] })
    setStashFileSelected(new Set())
  }

  return (
    <div className="tab-page stash-page">
      <ProjectToolbar {...{ directory, projects, choose, selectProject, removeProjectOption, active, stop, resume, defaultPathIcon }} />
      <RepositoryActionsBar {...{ directory, currentBranch, gitLfs, onBranchSwitch, incomingCommits, outgoingCommits, selected, aiBusy, gitBusy, generateCommitMessage, generateStashMergeMessage, mergeStashes, runGitRemote, requestPush, requestDeleteStash, selectedStashes, selectedStashFiles: [...stashFileSelected], restoreStash: restoreSelectedStash }} showStash showRestore showDeleteStash showRevert={false} />
      {changes.length > 0 && <FilesTable {...{ changes, query, selected, expanded, toggleFolder, toggleSelection, openDiff }} variant="stash" onQueryChange={setQuery} />}
      {!directory ? (
        <div className="empty"><div>—</div><h3>No project selected</h3><p>Select a project to view its stashes.</p></div>
      ) : !stashes.length ? (
        <div className="empty"><div>✓</div><h3>No stashes</h3><p>This project has no stored stashes.</p></div>
      ) : <div className="stash-accordion-list">{stashes.map(stash => {
        const isSelected = selectedStashes.some(item => item.ref === stash.ref)
        const isOpen = expandedStashRef === stash.ref
        return (
          <div className={`stash-accordion-item ${isOpen ? 'open' : ''}`} key={stash.ref}>
            <div className={`stash-card ${isSelected ? 'selected' : ''}`} role="button" tabIndex={0} onClick={() => setSelectedStashes(items => isSelected ? items.filter(item => item.ref !== stash.ref) : [...items, stash])} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setSelectedStashes(items => isSelected ? items.filter(item => item.ref !== stash.ref) : [...items, stash]) }}>
              <div className="stash-card-head"><strong>{stash.message || 'Unnamed stash'}</strong><span>{stash.date}</span><span className="stash-chevron branch-chevron" role="button" tabIndex={0} aria-expanded={isOpen} aria-label={isOpen ? 'Close stash files' : 'Open stash files'} onClick={event => { event.stopPropagation(); setExpandedStashRef(isOpen ? '' : stash.ref) }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); setExpandedStashRef(isOpen ? '' : stash.ref) } }} /></div>
            </div>
            {isOpen && <FilesTable
              changes={stash.files.map(file => ({ file, status: 'Stashed', code: '' }))}
              query={query}
              onQueryChange={setQuery}
              selected={stashFileSelected}
              expanded={stashFileExpanded}
              toggleFolder={toggleStashFolder}
              toggleSelection={toggleStashSelection}
              openDiff={() => {}}
              variant="stash-files"
              title="Stashed files"
              compact
            />}
          </div>
        )
      })}</div>}
    </div>
  )
}
