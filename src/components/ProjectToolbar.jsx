import Select, { components } from 'react-select'

function middleEllipsis(value, limit = 64) {
  if (value.length <= limit) return value
  const side = Math.floor((limit - 3) / 2)
  return `${value.slice(0, side)}…${value.slice(-side)}`
}

function projectName(project) {
  const directory = typeof project?.path === 'string' ? project.path : ''
  return project?.name || directory.split(/[\\/]/).filter(Boolean).at(-1) || directory || 'Unnamed project'
}

export default function ProjectToolbar({ directory, projects, choose, selectProject, removeProjectOption, active, stop, resume, defaultPathIcon }) {
  const currentProject = projects.find(project => project.path === directory) || (directory ? { path: directory } : null)
  const projectOptions = projects.some(project => project.path === directory) || !directory ? projects : [currentProject, ...projects]
  const options = projectOptions.map(project => ({ value: project.path, label: projectName(project), fullPath: project.path, icon: project.icon || defaultPathIcon }))

  return (
    <div className="toolbar">
      <div className="path project-picker">
        {directory && <button className="folder-button" title="Open in file browser" onClick={() => window.directoryAPI.openInExplorer()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2H20a1.5 1.5 0 0 1 1.5 1.5v7.5A1.5 1.5 0 0 1 20 19H4a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 4 6.5Z" /></svg>
        </button>}
        <Select
          className="project-react-select"
          classNamePrefix="project-select"
          isClearable={false}
          placeholder="Recent projects…"
          value={currentProject ? { value: currentProject.path, label: projectName(currentProject), fullPath: currentProject.path, icon: currentProject.icon || defaultPathIcon } : null}
          options={options}
          onChange={selectProject}
          menuPortalTarget={document.body}
          components={{
            SingleValue: projectValue => <components.SingleValue {...projectValue}><span className="project-single-value" title={projectValue.data.fullPath}><img src={projectValue.data.icon} alt="" />{projectValue.data.label}</span></components.SingleValue>,
            Option: projectOption => <components.Option {...projectOption}><span className="project-option-label" title={projectOption.data.fullPath}><img src={projectOption.data.icon} alt="" />{projectOption.data.label}</span><button className="project-remove" title="Remove project" onClick={event => { event.stopPropagation(); removeProjectOption(projectOption.data) }}>×</button></components.Option>,
          }}
          styles={{
            container: base => ({ ...base, flex: 1, minWidth: 0 }),
            control: base => ({ ...base, background: 'transparent', border: 0, boxShadow: 'none', minHeight: 30 }),
            valueContainer: base => ({ ...base, padding: 0 }),
            indicatorsContainer: base => ({ ...base, padding: 0 }),
            menuPortal: base => ({ ...base, zIndex: 100 }),
            menu: base => ({ ...base, background: '#24272a', color: '#f3f4f6' }),
            menuList: base => ({ ...base, background: '#24272a', padding: 4 }),
            option: (base, state) => ({ ...base, background: state.isFocused ? '#343a3f' : '#24272a', color: '#f3f4f6', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }),
          }}
        />
      </div>
      <button className="primary" onClick={choose}>＋ Choose directory</button>
      {active ? <button className="ghost" onClick={stop}>Stop</button> : directory && <button className="ghost" onClick={resume}>Start</button>}
    </div>
  )
}
