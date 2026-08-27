export default function WatchingPill({ active, starting, indexing, directory, stop, resume }) {
  // Starting outranks active: switching project republishes the old directory before the
  // new scan lands, and the led should keep pulsing until the scan on screen is the new one.
  const state = starting ? 'starting' : indexing ? 'indexing' : active ? 'active' : 'inactive'
  const label = starting ? 'STARTING' : indexing ? 'INDEXING' : active ? 'WATCHING' : 'STOPPED'

  return (
    <button
      type="button"
      className={`watching-pill ${state}`}
      disabled={!directory || starting}
      aria-pressed={active}
      aria-busy={starting || indexing || undefined}
      aria-label={starting ? 'Starting directory watcher' : indexing ? 'Indexing project files' : active ? 'Stop directory watcher' : 'Start directory watcher'}
      onClick={active ? stop : resume}
    >
      <i aria-hidden="true" />
      {label}
    </button>
  )
}
