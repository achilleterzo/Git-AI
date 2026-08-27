import BranchSwitcher from './BranchSwitcher'
import LfsPill from './LfsPill'
import { useEffect, useRef, useState } from 'react'

export default function RepositoryActionsBar({ directory, currentBranch, gitLfs, onBranchSwitch, incomingCommits, outgoingCommits, hasCommits, selected, changes = [], aiBusy, gitBusy, generateCommitMessage, moveSelected, generateStashMergeMessage, runGitRemote, requestPush, requestRevert, requestDeleteStash, selectedStashes = [], selectedStashFiles = [], restoreStash, mergeStashes, onTagCommit, showCommit = false, showMove = false, showAmend = false, showPull = false, showPush = false, showStash = false, showStashOutside = false, showRestore = false, showRevert = false, showDeleteStash = false, showTag = false }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const [stuck, setStuck] = useState(false)
  const barRef = useRef(null)
  const hasMoreActions = showMove || showAmend || showStash || showRevert
  const canMove = selected.size === 2 && [...selected].map(path => changes.find(change => change.file === path)?.status).sort().join(',') === 'Added,Deleted'

  // Pinned at top:0 the bar covers the scrollport edge, so the negative root
  // margin clips its first pixel — that drop below full visibility is the cue
  // that it has left its resting place in the flow and turned into a toolbar.
  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const observer = new IntersectionObserver(([entry]) => setStuck(entry.intersectionRatio < 1), { threshold: [1], rootMargin: '-1px 0px 0px 0px' })
    observer.observe(bar)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={barRef} className={`repository-actions-bar ${stuck ? 'is-stuck' : ''}`}>
      <div className="repository-label-group">
        <span>REPOSITORY</span>
        <BranchSwitcher directory={directory} currentBranch={currentBranch} onSwitch={onBranchSwitch} />
        <LfsPill active={gitLfs} directory={directory} />
      </div>
      <div className="repository-action-buttons">
        {showPull && <button className="git-button" disabled={!directory || gitBusy} onClick={() => runGitRemote('pull')}>↓ Pull ({incomingCommits})</button>}
        {showPush && <button className="git-button" disabled={!directory || gitBusy || outgoingCommits < 1} onClick={() => requestPush()}>↑ Push ({outgoingCommits})</button>}
        {showTag && <button className="git-button" disabled={!directory || gitBusy} onClick={() => onTagCommit()}>◇ Release tag</button>}
        {showCommit && <button className="git-button" disabled={!selected.size || aiBusy} onClick={() => generateCommitMessage()}>{aiBusy ? 'Generating…' : '✦ Commit'}</button>}
        {showStashOutside && <button className="git-button" disabled={!selected.size || aiBusy} onClick={() => generateCommitMessage('stash')}>{aiBusy ? 'Generating…' : '✦ Stash'}</button>}
        {hasMoreActions && <div className="repository-more-actions"><button className="git-button more-actions-button" title="More repository actions" aria-label="More repository actions" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}>•••</button>{moreOpen && <div className="repository-more-menu">{showMove && <button disabled={!canMove || aiBusy || gitBusy} onClick={() => { setMoreOpen(false); moveSelected([...selected]) }}>↔ Move</button>}<button disabled={!selected.size || aiBusy || !hasCommits} onClick={() => { setMoreOpen(false); generateCommitMessage('amend') }}>✦ Amend</button><button disabled={!selected.size || aiBusy} onClick={() => { setMoreOpen(false); generateCommitMessage('stash') }}>✦ Stash</button><button className="danger-menu-item" disabled={!selected.size || gitBusy} onClick={() => { setMoreOpen(false); requestRevert() }}>↶ Revert</button></div>}</div>}
        {showRestore && <button className="git-button" disabled={(!selectedStashes.length && !selectedStashFiles.length) || gitBusy} onClick={() => restoreStash()}>↶ {selectedStashFiles.length ? `Unstash file${selectedStashFiles.length > 1 ? 's' : ''} (${selectedStashFiles.length})` : `Unstash${selectedStashes.length > 1 ? ` (${selectedStashes.length})` : ''}`}</button>}
        {selectedStashes.length > 1 && <button className="git-button" disabled={aiBusy || gitBusy} onClick={() => generateStashMergeMessage()}>✦ Merge stashes</button>}
        {showDeleteStash && <button className="git-button danger-button" disabled={!selectedStashes.length || gitBusy} onClick={() => requestDeleteStash()}>× Delete stash{selectedStashes.length > 1 ? ` (${selectedStashes.length})` : ''}</button>}
      </div>
    </div>
  )
}
