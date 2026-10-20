import { useEffect, useState } from 'react'

export default function BranchSwitcher({ directory, currentBranch, onSwitch }) {
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState({ local: [], remote: [] })
  const [newBranch, setNewBranch] = useState('')
  const [base, setBase] = useState(currentBranch || '')
  const [remoteInput, setRemoteInput] = useState('')
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [renameInput, setRenameInput] = useState('')

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

  async function renameBranch(newName) {
    const name = newName.trim()
    if (!name || !currentBranch || name === currentBranch) return
    try {
      const result = await window.directoryAPI.renameBranch(currentBranch, name)
      setRenameInput('')
      setOpen(false)
      onSwitch({ remoteConnected: true })
      if (result?.remoteNotRenamed) onSwitch({ error: `Branch renamed locally to "${name}". The branch on the remote was not renamed; publish "${name}" to create it there.` })
    } catch (error) {
      onSwitch({ error: error.message })
    }
  }

  useEffect(() => { if (currentBranch) setBase(currentBranch) }, [currentBranch])

  const remoteDefault = branches.remoteDefaultBranch
  const baseOptions = [...branches.local.filter(branch => !(branches.unborn && branch === currentBranch)), ...branches.remote]

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
        {remoteDefault && currentBranch && remoteDefault !== currentBranch && <div className="branch-remote">
          <label>The remote default branch is "{remoteDefault}", but you are on "{currentBranch}".</label>
          <button type="button" className="primary" onClick={() => renameBranch(remoteDefault)}>Rename to {remoteDefault}</button>
        </div>}
        <div className="branch-menu-list">
          {branches.local.map(branch => <button type="button" className={branch === currentBranch ? 'selected' : ''} key={`local-${branch}`} onClick={() => { setOpen(false); if (branch !== currentBranch || !branches.unborn) onSwitch({ target: branch }) }}>{branch}<small>{branches.unborn && branch === currentBranch ? 'no commits yet' : 'local'}</small></button>)}
          {branches.remote.map(branch => <button type="button" key={`remote-${branch}`} onClick={() => { setOpen(false); onSwitch({ target: branch, remote: true }) }}>{branch}<small>remote</small></button>)}
        </div>
        <div className="branch-create">
          <label>New branch</label>
          <input value={newBranch} onChange={event => setNewBranch(event.target.value)} placeholder="feature/my-branch" />
          <select value={base} onChange={event => setBase(event.target.value)}>
            {baseOptions.map(branch => <option key={branch} value={branch}>{branch}</option>)}
          </select>
          <button type="button" className="primary" disabled={!newBranch.trim()} onClick={() => { setOpen(false); onSwitch({ newBranch: newBranch.trim(), base: baseOptions.includes(base) ? base : '' }) }}>Create and switch</button>
        </div>
        {currentBranch && <div className="branch-create">
          <label>Rename "{currentBranch}"</label>
          <input value={renameInput} onChange={event => setRenameInput(event.target.value)} placeholder="main" />
          <button type="button" className="primary" disabled={!renameInput.trim() || renameInput.trim() === currentBranch} onClick={() => renameBranch(renameInput)}>Rename branch</button>
        </div>}
      </div>}
    </div>
  )
}
