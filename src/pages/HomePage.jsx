export default function HomePage({ projects, directory, defaultPathIcon, choose, openHomeProject, editProject, projectName, LfsPill }) {
  const sortedProjects = projects.slice().sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))
  return <div className="home-page">
    <header>
      <div>
        <p className="eyebrow">WORKSPACE / HOME</p>
        <h1>Projects</h1>
        <p className="muted">Open one of your saved Git repositories.</p>
      </div>
    </header>
    <div className="home-project-grid">
      <button className="home-project-card new-project-card" onClick={choose}>
        <span className="new-project-icon">＋</span>
        <span>New project</span>
        <small>Choose a directory</small>
      </button>
      {sortedProjects.map(project => <div className={`home-project-card project-card ${project.path === directory ? 'active' : ''}`} key={project.path} title={project.path} onClick={() => openHomeProject(project)}>
        <div className="project-card-icon-row"><img src={project.icon || defaultPathIcon} alt="" /><LfsPill active={project.gitLfs === true} directory={project.path} /></div>
        <span>{projectName(project)}</span>
        <small>Open project</small>
        <button className="project-edit-button" title="Edit project" onClick={event => { event.stopPropagation(); editProject(project) }}>Edit</button>
      </div>)}
    </div>
  </div>
}
