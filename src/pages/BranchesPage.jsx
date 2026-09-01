import React, { useEffect, useState } from 'react'
import RepositoryActionsBar from '../components/RepositoryActionsBar'
import ProjectToolbar from '../components/ProjectToolbar'

export default function BranchesPage({ directory, projects, choose, selectProject, removeProjectOption, active, stop, resume, defaultPathIcon, currentBranch, gitLfs, onBranchSwitch, incomingCommits, outgoingCommits, runGitRemote, requestPush, runOperation, setErrorModal }) {
  const [branches, setBranches] = useState({ local: [], remote: [], remoteUrl: '' })
  const [newBranch, setNewBranch] = useState('')

  async function refresh() { try { setBranches(await window.directoryAPI.getBranches()) } catch (error) { setErrorModal(error.message) } }
  useEffect(() => { if (directory) refresh() }, [directory, currentBranch])
  async function createBranch(event) {
    event.preventDefault()
    if (!newBranch.trim()) return
    try { await runOperation('Creating branch…', () => window.directoryAPI.switchBranch({ newBranch: newBranch.trim() })); setNewBranch(''); await refresh() } catch (error) { setErrorModal(error.message) }
  }
  async function switchBranch(name) {
    try { await runOperation('Switching branch…', () => window.directoryAPI.switchBranch({ target: name })); await refresh() } catch (error) { setErrorModal(error.message) }
  }
  async function deleteBranch(name) {
    if (!window.confirm(`Delete local branch "${name}"? Git will refuse if it has unmerged commits.`)) return
    try { await runOperation('Deleting branch…', () => window.directoryAPI.deleteBranch(name)); await refresh() } catch (error) { setErrorModal(error.message) }
  }
  return <div className="branches-page">
    <ProjectToolbar {...{ directory, projects, choose, selectProject, removeProjectOption, active, stop, resume, defaultPathIcon }} />
    <RepositoryActionsBar {...{ directory, currentBranch, gitLfs, onBranchSwitch, incomingCommits, outgoingCommits, runGitRemote, requestPush, selected: new Set(), gitBusy: false, showPull: true, showPush: true }} />
    <div className="branches-toolbar"><div><h1>Branches</h1><p className="muted">Create, switch and clean up the branches in this repository.</p></div><button className="ghost" onClick={refresh}>Refresh</button></div>
    <form className="branch-create-page" onSubmit={createBranch}><label>New branch<div className="branch-input-group"><input value={newBranch} onChange={event => setNewBranch(event.target.value)} placeholder="feature/my-branch" /><button className="primary" disabled={!newBranch.trim()}>Create and switch</button></div></label></form>
    <section className="branch-section"><div className="branch-section-head"><h2>Local branches</h2><span>{branches.local.length}</span></div><div className="branch-list">{branches.local.map(name => <div className={`branch-row ${name === currentBranch ? 'current' : ''}`} key={name}><div><strong>{name}</strong>{name === currentBranch && <small>Current branch</small>}</div><div className="branch-row-actions"><button className="ghost" disabled={name === currentBranch} onClick={() => switchBranch(name)}>Switch</button><button className="ghost danger-button" disabled={name === currentBranch} onClick={() => deleteBranch(name)}>Delete</button></div></div>)}</div></section>
    {branches.remote.length > 0 && <section className="branch-section"><div className="branch-section-head"><h2>Remote branches</h2><span>{branches.remote.length}</span></div><div className="branch-list">{branches.remote.map(name => <div className="branch-row" key={name}><strong>{name}</strong><button className="ghost" onClick={() => onBranchSwitch({ target: name, remote: true })}>Checkout</button></div>)}</div></section>}
  </div>
}
