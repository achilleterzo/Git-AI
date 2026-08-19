import React, { useEffect, useState } from 'react'
import RepositoryActionsBar from '../components/RepositoryActionsBar'
import ConfirmationModal from '../components/ConfirmationModal'
import ProjectToolbar from '../components/ProjectToolbar'

const formatDate = value => { try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) } catch { return value } }

export default function HistoryPage({ directory, projects, choose, selectProject, removeProjectOption, active, stop, resume, defaultPathIcon, currentBranch, gitLfs, onBranchSwitch, incomingCommits, outgoingCommits, runGitRemote, requestPush, runOperation, setErrorModal, aiEnabled, refreshPendingCommitCount }) {
  const [commits, setCommits] = useState([])
  const [pendingCommits, setPendingCommits] = useState([])
  const [amendTarget, setAmendTarget] = useState(null)
  const [amendMessage, setAmendMessage] = useState('')
  const [deleteTagTarget, setDeleteTagTarget] = useState('')
  const [tagTarget, setTagTarget] = useState(null)
  const [tagName, setTagName] = useState('')
  const [tagMessage, setTagMessage] = useState('')
  const [annotated, setAnnotated] = useState(true)
  const [releaseAiBusy, setReleaseAiBusy] = useState(false)

  async function refresh() { try { const [history, pending] = await Promise.all([window.directoryAPI.getHistory(), window.directoryAPI.getPendingCommits()]); const pendingHashes = new Set(pending.map(commit => commit.hash)); const pendingWithTags = pending.map(commit => history.find(item => item.hash === commit.hash) || { ...commit, tags: [], pushedTags: [] }); setPendingCommits(pendingWithTags); setCommits(history.filter(commit => !pendingHashes.has(commit.hash))) } catch (error) { setErrorModal(error.message) } }
  useEffect(() => { if (directory) refresh() }, [directory, incomingCommits, outgoingCommits])
  async function createTag(event) {
    event.preventDefault()
    try {
      await runOperation(tagTarget.release ? 'Creating release tag…' : 'Creating tag…', () => window.directoryAPI.createTag({ name: tagName, commit: tagTarget.hash || 'HEAD', message: tagMessage, annotated: tagTarget.release ? true : annotated }))
      if (tagTarget.release) await runOperation(`Publishing ${tagName}…`, () => window.directoryAPI.pushTag(tagName), { trackProgress: true })
      setTagTarget(null); setTagName(''); setTagMessage(''); await refresh()
    } catch (error) { setErrorModal(error.message) }
  }
  async function openReleaseTag() {
    if (!aiEnabled) { setTagName(''); setTagMessage(''); setTagTarget({ release: true, base: '' }); return }
    setReleaseAiBusy(true)
    try {
      const proposal = await runOperation('Analyzing release changes…', () => window.directoryAPI.generateReleaseTag())
      setTagName(proposal.name); setTagMessage(proposal.message); setTagTarget({ release: true, base: proposal.base, hasChanges: proposal.hasChanges })
    } catch (error) { setErrorModal(error.message) } finally { setReleaseAiBusy(false) }
  }
  async function deleteTag(name) {
    setDeleteTagTarget(name)
  }
  function openCommitTag(commit) { setTagName(''); setTagMessage(''); setAnnotated(true); setTagTarget(commit) }
  async function confirmDeleteTag() {
    const name = deleteTagTarget
    setDeleteTagTarget('')
    if (!name) return
    try { await runOperation('Deleting tag…', () => window.directoryAPI.deleteTag(name)); await refresh() } catch (error) { setErrorModal(error.message) }
  }
  async function pushTag(name) { try { await runOperation(`Pushing ${name}…`, () => window.directoryAPI.pushTag(name), { trackProgress: true }) } catch (error) { setErrorModal(error.message) } }
  async function refreshAfterRemote(action) { await runGitRemote(action); await refresh() }
  async function confirmAmend(event) { event.preventDefault(); try { await runOperation('Amending commit message…', () => window.directoryAPI.amendCommitMessage(amendMessage)); setAmendTarget(null); setAmendMessage(''); await refresh(); await refreshPendingCommitCount() } catch (error) { setErrorModal(error.message) } }
  return <div className="history-page">
    <ProjectToolbar {...{ directory, projects, choose, selectProject, removeProjectOption, active, stop, resume, defaultPathIcon }} />
    <RepositoryActionsBar {...{ directory, currentBranch, gitLfs, onBranchSwitch, incomingCommits, outgoingCommits, runGitRemote: refreshAfterRemote, requestPush, selected: new Set(), gitBusy: releaseAiBusy, onTagCommit: openReleaseTag, showPull: true, showPush: true, showTag: true }} />
    {pendingCommits.length > 0 && <section className="history-section"><div className="history-section-head"><div><h2>Pending commits</h2><p className="muted">Local commits not yet published to the tracking branch.</p></div><span>{pendingCommits.length}</span></div><div className="history-list">{pendingCommits.map((commit, index) => <article className="history-card" key={commit.hash}><div className="history-card-main"><div className="history-commit-meta"><code>{commit.shortHash}</code><span>{formatDate(commit.date)}</span><span>{commit.author}</span></div><h3>{commit.message}</h3><div className="history-tags">{(commit.tags || []).map(tag => <span className="history-tag" key={tag}><span>{tag}</span>{(commit.pushedTags || []).includes(tag) ? <small className="history-tag-pushed">Pushed</small> : <button title={`Push ${tag}`} onClick={() => pushTag(tag)}>↑</button>}<button title={`Delete ${tag}`} onClick={() => deleteTag(tag)}>×</button></span>)}<button className="history-add-tag" onClick={() => openCommitTag(commit)}>＋ Tag commit</button>{index === 0 && <button className="history-add-tag" onClick={() => { setAmendTarget(commit); setAmendMessage(commit.message) }}>✎ Amend message</button>}</div></div></article>)}</div></section>}
    <section className="history-section"><div className="history-section-head"><div><h2>Commit history</h2><p className="muted">Browse commits and manage their Git tags.</p></div><button className="ghost" onClick={refresh}>Refresh</button></div><div className="history-list">{commits.length ? commits.map(commit => <article className="history-card" key={commit.hash}><div className="history-card-main"><div className="history-commit-meta"><code>{commit.shortHash}</code><span>{formatDate(commit.date)}</span><span>{commit.author}</span></div><h3>{commit.message}</h3><div className="history-tags">{commit.tags.map(tag => <span className="history-tag" key={tag}><span>{tag}</span>{(commit.pushedTags || []).includes(tag) ? <small className="history-tag-pushed">Pushed</small> : <button title={`Push ${tag}`} onClick={() => pushTag(tag)}>↑</button>}<button title={`Delete ${tag}`} onClick={() => deleteTag(tag)}>×</button></span>)}<button className="history-add-tag" onClick={() => openCommitTag(commit)}>＋ Tag commit</button></div></div></article>) : <div className="empty"><div>⌁</div><h3>No commits found</h3><p>This repository does not have commit history yet.</p></div>}</div></section>
    {amendTarget && <div className="modal-backdrop" onClick={() => setAmendTarget(null)}><form className="modal" onClick={event => event.stopPropagation()} onSubmit={confirmAmend}><h2>Amend commit message</h2><p className="muted">Only the message of <code>{amendTarget.shortHash}</code> will change. The commit will receive a new hash.</p><textarea autoFocus value={amendMessage} onChange={event => setAmendMessage(event.target.value)} /><div className="modal-actions"><button type="button" className="ghost" onClick={() => setAmendTarget(null)}>Cancel</button><button className="primary" disabled={!amendMessage.trim()}>Amend commit</button></div></form></div>}
    {tagTarget && <div className="modal-backdrop" onClick={() => setTagTarget(null)}><form className="modal" onClick={event => event.stopPropagation()} onSubmit={createTag}><h2>{tagTarget.release ? 'Create release tag' : 'Create tag'}</h2><p className="muted">{tagTarget.release ? <span>{tagTarget.hasChanges === false ? 'No new commits were detected since the latest tag. You can still create a release tag manually.' : `AI analyzed the changes since ${tagTarget.base || 'the beginning of history'}.`} The tag will be created on <code>HEAD</code> and pushed to <code>origin</code>.</span> : <span>Create a tag on commit <code>{tagTarget.shortHash}</code>.</span>}</p><label>Tag name<input autoFocus value={tagName} onChange={event => setTagName(event.target.value)} placeholder="v1.5.0" /></label>{tagTarget.release ? <label>Release message<textarea className="release-message-input" rows="5" value={tagMessage} onChange={event => setTagMessage(event.target.value)} placeholder="Release v1.5.0" /></label> : <div><label className="history-checkbox"><input type="checkbox" checked={annotated} onChange={event => setAnnotated(event.target.checked)} /> Annotated tag</label>{annotated && <label>Message<input value={tagMessage} onChange={event => setTagMessage(event.target.value)} placeholder="Tag message" /></label>}</div>}<div className="modal-actions"><button type="button" className="ghost" onClick={() => setTagTarget(null)}>Cancel</button><button className="primary" disabled={!tagName.trim() || (tagTarget.release ? !tagMessage.trim() : annotated && !tagMessage.trim())}>{tagTarget.release ? 'Create and push tag' : 'Create tag'}</button></div></form></div>}
    {deleteTagTarget && <ConfirmationModal title="Delete tag" message="This removes the tag only from the local repository. The remote tag will not be deleted." details={<div><span>TAG</span><strong>{deleteTagTarget}</strong></div>} danger confirmLabel="Delete tag" onCancel={() => setDeleteTagTarget('')} onConfirm={confirmDeleteTag} />}
  </div>
}
