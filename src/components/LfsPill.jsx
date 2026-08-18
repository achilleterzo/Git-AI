export default function LfsPill({ active, directory }) {
  return <span className={`lfs-pill ${active ? 'active' : ''} ${directory ? '' : 'disabled'}`} title={active ? 'Git LFS is available' : 'Git LFS is not enabled'}>LFS</span>
}
