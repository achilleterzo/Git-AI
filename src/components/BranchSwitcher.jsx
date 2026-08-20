import { useEffect, useState } from 'react'

export default function BranchSwitcher({ directory, currentBranch, onSwitch }) {
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState({ local: [], remote: [] })
  const [newBranch, setNewBranch] = useState('')
  const [base, setBase] = useState(currentBranch || '')
  const [remoteInput, setRemoteInput] = useState('')
  const [remoteBusy, setRemoteBusy] = useState(false)

  async function openSwitcher() {
    if (!directory) return
    try {
      const result = await window.directoryAPI.getBranches()
      setBranches(result)
      setRemoteInput(result.remoteUrl || '')
      setBase(currentBranch || '')
      setOpen(value => !value)
    } catch (error) {
      onSwitch({ error: error.message })
    }
  }

  async function connectRemote() {
    if (!remoteInput.trim()) return
    setRemoteBusy(true)
    try {
      await window.directoryAPI.connectRemote(remoteInput)
      const result = await window.directoryAPI.getBranches()
      setBranches(result)
      setRemoteInput(result.remoteUrl || remoteInput.trim())
      setOpen(false)
      onSwitch({ remoteConnected: true })
    } catch (error) {
      onSwitch({ error: error.message })
    } finally {
      setRemoteBusy(false)
    }
  }

  useEffect(() => { if (currentBranch) setBase(currentBranch) }, [currentBranch])

  return (
    <div className="branch-switcher">
      <button type="button" className="branch-pill" disabled={!directory} onClick={openSwitcher} aria-expanded={open}>
        {currentBranch || 'No branch'} <span className="branch-chevron" aria-hidden="true" />
      </button>
      {open && <div className="branch-menu">
        <strong>Switch branch</strong>
        <div className="branch-remote">
          <label>Remote origin</label>
          <input value={remoteInput} onChange={event => setRemoteInput(event.target.value)} placeholder="https://github.com/user/repository.git" />
          <button type="button" className="primary" disabled={!remoteInput.trim() || remoteBusy} onClick={connectRemote}>{remoteBusy ? 'Updating…' : branches.remoteUrl ? 'Update remote' : 'Connect remote'}</button>
        </div>
        <div className="branch-menu-list">
          {branches.local.map(branch => <button type="button" className={branch === currentBranch ? 'selected' : ''} key={`local-${branch}`} onClick={() => { setOpen(false); onSwitch({ target: branch }) }}>{branch}<small>local</small></button>)}
          {branches.remote.map(branch => <button type="button" key={`remote-${branch}`} onClick={() => { setOpen(false); onSwitch({ target: branch, remote: true }) }}>{branch}<small>remote</small></button>)}
        </div>
        <div className="branch-create">
          <label>New branch</label>
          <input value={newBranch} onChange={event => setNewBranch(event.target.value)} placeholder="feature/my-branch" />
          <select value={base} onChange={event => setBase(event.target.value)}>
            {[...branches.local, ...branches.remote].map(branch => <option key={branch} value={branch}>{branch}</option>)}
          </select>
          <button type="button" className="primary" disabled={!newBranch.trim()} onClick={() => { setOpen(false); onSwitch({ newBranch: newBranch.trim(), base }) }}>Create and switch</button>
        </div>
      </div>}
    </div>
  )
}
