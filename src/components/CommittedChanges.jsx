import { useEffect, useState } from 'react'

const formatDate = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString() }

// Unpushed commits, newest first. Undo moves a commit's changes back into the working tree.
export default function CommittedChanges({ directory, outgoingCommits, changes, commitsVersion, gitBusy, requestUndoCommit }) {
  const [commits, setCommits] = useState([])
  useEffect(() => {
    let cancelled = false
    if (!directory) { setCommits([]); return undefined }
    window.directoryAPI.getPendingCommits().then(list => { if (!cancelled) setCommits(Array.isArray(list) ? list : []) }).catch(() => { if (!cancelled) setCommits([]) })
    return () => { cancelled = true }
  }, [directory, outgoingCommits, changes, commitsVersion])
  if (!commits.length) return null
  return (
    <div className="panel committed-changes-panel">
      <div className="panel-head">
        <div>
          <h2>Committed changes</h2>
          <p>{commits.length} local commit{commits.length === 1 ? '' : 's'} not pushed yet</p>
        </div>
      </div>
      <div className="committed-list">
        {commits.map((commit, index) => <div className="committed-row" key={commit.hash}>
          <code>{commit.shortHash}</code>
          <span className="committed-message" title={commit.message}>{commit.message}</span>
          <small>{formatDate(commit.date)}</small>
          <button type="button" className="ghost committed-undo" disabled={gitBusy || commit.parents.length > 1} title={commit.parents.length > 1 ? 'Merge commits cannot be undone here' : index === 0 ? 'Undo this commit and keep its changes (git reset --soft HEAD~1)' : 'Remove this commit from history and keep its changes'} onClick={() => requestUndoCommit(commit)}>Undo commit</button>
        </div>)}
      </div>
    </div>
  )
}
