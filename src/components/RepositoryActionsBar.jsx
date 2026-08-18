import BranchSwitcher from './BranchSwitcher'
import LfsPill from './LfsPill'
import { useState } from 'react'

export default function RepositoryActionsBar({ directory, currentBranch, gitLfs, onBranchSwitch, incomingCommits, outgoingCommits, hasCommits, selected, aiBusy, gitBusy, generateCommitMessage, generateStashMergeMessage, runGitRemote, requestPush, requestRevert, requestDeleteStash, selectedStashes = [], selectedStashFiles = [], restoreStash, mergeStashes, showCommit = false, showAmend = false, showPull = false, showPush = false, showStash = false, showStashOutside = false, showRestore = false, showRevert = false, showDeleteStash = false }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const hasMoreActions = showAmend || showStash || showRevert
  return (
    <div className="repository-actions-bar">
      <div className="repository-label-group">
        <span>REPOSITORY</span>
        <BranchSwitcher directory={directory} currentBranch={currentBranch} onSwitch={onBranchSwitch} />
        <LfsPill active={gitLfs} directory={directory} />
      </div>
      <div className="repository-action-buttons">
        {showPull && <button className="git-button" disabled={!directory || gitBusy} onClick={() => runGitRemote('pull')}>↓ Pull ({incomingCommits})</button>}
        {showPush && <button className="git-button" disabled={!directory || gitBusy || outgoingCommits < 1} onClick={() => requestPush()}>↑ Push ({outgoingCommits})</button>}
        {showCommit && <button className="git-button" disabled={!selected.size || aiBusy} onClick={() => generateCommitMessage()}>{aiBusy ? 'Generating…' : '✦ Commit'}</button>}
        {showStashOutside && <button className="git-button" disabled={!selected.size || aiBusy} onClick={() => generateCommitMessage('stash')}>{aiBusy ? 'Generating…' : '✦ Stash'}</button>}
        {hasMoreActions && <div className="repository-more-actions"><button className="git-button more-actions-button" title="More repository actions" aria-label="More repository actions" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}>•••</button>{moreOpen && <div className="repository-more-menu"><button disabled={!selected.size || aiBusy || !hasCommits} onClick={() => { setMoreOpen(false); generateCommitMessage('amend') }}>✦ Amend</button><button disabled={!selected.size || aiBusy} onClick={() => { setMoreOpen(false); generateCommitMessage('stash') }}>✦ Stash</button><button className="danger-menu-item" disabled={!selected.size || gitBusy} onClick={() => { setMoreOpen(false); requestRevert() }}>↶ Revert</button></div>}</div>}
        {showRestore && <button className="git-button" disabled={(!selectedStashes.length && !selectedStashFiles.length) || gitBusy} onClick={() => restoreStash()}>↶ {selectedStashFiles.length ? `Unstash file${selectedStashFiles.length > 1 ? 's' : ''} (${selectedStashFiles.length})` : `Unstash${selectedStashes.length > 1 ? ` (${selectedStashes.length})` : ''}`}</button>}
        {selectedStashes.length > 1 && <button className="git-button" disabled={aiBusy || gitBusy} onClick={() => generateStashMergeMessage()}>✦ Merge stashes</button>}
        {showDeleteStash && <button className="git-button danger-button" disabled={!selectedStashes.length || gitBusy} onClick={() => requestDeleteStash()}>× Delete stash{selectedStashes.length > 1 ? ` (${selectedStashes.length})` : ''}</button>}
      </div>
    </div>
  )
}
