export default function WatchingPill({ active, directory, stop, resume }) {
  const label = active ? 'WATCHING' : 'STOPPED'

  return (
    <button
      type="button"
      className={`watching-pill ${active ? 'active' : 'inactive'}`}
      disabled={!directory}
      aria-pressed={active}
      aria-label={active ? 'Stop directory watcher' : 'Start directory watcher'}
      onClick={active ? stop : resume}
    >
      <i aria-hidden="true" />
      {label}
    </button>
  )
}
