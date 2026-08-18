import { useEffect, useState } from 'react'
import FilesTable from '../components/FilesTable'

export default function LfsPage({ directory, gitLfs, loading, setLoading, setErrorModal }) {
  const [patterns, setPatterns] = useState([])
  const [files, setFiles] = useState([])
  const [pattern, setPattern] = useState('')
  const [fileQuery, setFileQuery] = useState('')
  const [selectedFiles, setSelectedFiles] = useState(new Set())
  const [expandedFiles, setExpandedFiles] = useState(new Set(['']))

  async function refreshLfs() {
    try {
      const result = await window.directoryAPI.getLfsConfig()
      setPatterns([...new Set(result.patterns || [])])
      setFiles(result.files || [])
    } catch (error) { setErrorModal(error.message) }
  }

  useEffect(() => { if (directory && gitLfs) refreshLfs() }, [directory, gitLfs])

  const trackedFiles = files.map(file => ({ file, status: 'Tracked', code: 'LFS' }))
  function toggleFileFolder(path) { setExpandedFiles(value => { const next = new Set(value); next.has(path) ? next.delete(path) : next.add(path); return next }) }
  function toggleFileSelection(paths) { setSelectedFiles(value => { const next = new Set(value); const shouldSelect = paths.some(path => !next.has(path)); paths.forEach(path => shouldSelect ? next.add(path) : next.delete(path)); return next }) }

  async function trackPattern(event) {
    event.preventDefault()
    if (!pattern.trim()) return
    setLoading('Tracking LFS pattern…')
    try { await window.directoryAPI.trackLfs(pattern.trim()); setPattern(''); await refreshLfs() } catch (error) { setErrorModal(error.message) } finally { setLoading('') }
  }

  async function untrackPattern(value) {
    setLoading('Removing LFS pattern…')
    try { await window.directoryAPI.untrackLfs(value); await refreshLfs() } catch (error) { setErrorModal(error.message) } finally { setLoading('') }
  }

  return (
    <div className="lfs-page">
      <div className="lfs-card">
        <div className="lfs-card-head"><div><span className="eyebrow">REPOSITORY / LFS</span><h2>Large File Storage</h2><p className="muted">Configure the file patterns managed by Git LFS.</p></div><span className="lfs-status">ACTIVE</span></div>
        <form className="lfs-track-form" onSubmit={trackPattern}><input value={pattern} onChange={event => setPattern(event.target.value)} placeholder="*.psd, assets/**/*.zip" /><button className="primary" disabled={!pattern.trim()}>Track pattern</button></form>
      </div>
      <section className="lfs-card lfs-patterns-card"><div className="lfs-section-head"><h3>Tracked patterns</h3><span>{patterns.length}</span></div>{patterns.length ? <div className="lfs-tag-list">{patterns.map((item, index) => <span className="lfs-tag" title={item} key={`${item}-${index}`}><span>{item}</span><button type="button" className="lfs-tag-remove" title={`Untrack ${item}`} aria-label={`Untrack ${item}`} onClick={() => untrackPattern(item)}>×</button></span>)}</div> : <p className="muted">No patterns configured.</p>}</section>
      <FilesTable changes={trackedFiles} query={fileQuery} onQueryChange={setFileQuery} selected={selectedFiles} expanded={expandedFiles} toggleFolder={toggleFileFolder} toggleSelection={toggleFileSelection} openDiff={() => {}} title="LFS files" emptyMessage="No LFS files in this repository." variant="lfs" />
    </div>
  )
}
