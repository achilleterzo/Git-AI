export default function WatchingPill({ active, starting, directory, stop, resume }) {
  // Starting outranks active: switching project republishes the old directory before the
  // new scan lands, and the led should keep pulsing until the scan on screen is the new one.
  const state = starting ? 'starting' : active ? 'active' : 'inactive'
  const label = starting ? 'STARTING' : active ? 'WATCHING' : 'STOPPED'

  return (
    <button
      type="button"
      className={`watching-pill ${state}`}
      disabled={!directory || starting}
      aria-pressed={active}
      aria-busy={starting || undefined}
      aria-label={starting ? 'Starting directory watcher' : active ? 'Stop directory watcher' : 'Start directory watcher'}
      onClick={active ? stop : resume}
    >
      <i aria-hidden="true" />
      {label}
    </button>
  )
}
