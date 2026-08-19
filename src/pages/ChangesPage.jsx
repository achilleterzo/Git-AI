import ProjectToolbar from '../components/ProjectToolbar'
import RepositoryActionsBar from '../components/RepositoryActionsBar'
import FilesTable from '../components/FilesTable'

export default function ChangesPage({ directory, projects, choose, selectProject, removeProjectOption, active, stop, resume, defaultPathIcon, emptyDirectory, checkoutRemote, setCheckoutRemote, initializeEmptyDirectory, checkoutEmptyDirectory, currentBranch, gitLfs, onBranchSwitch, incomingCommits, outgoingCommits, hasCommits, selected, aiBusy, gitBusy, generateCommitMessage, runGitRemote, requestPush, requestRevert, changes, query, setQuery, expanded, toggleFolder, toggleSelection, expandAllFolders, collapseAllFolders, openDiff }) {
  return (
    <div className="tab-page changes-page">
      {emptyDirectory && (
        <div className="repository-setup">
          <div>
            <h2>Set up repository</h2>
            <p>The folder has been added to your projects. Choose whether to initialize a new Git repository or check out a remote one.</p>
            <small>{emptyDirectory}</small>
          </div>
          <div className="repository-setup-actions">
            <button className="ghost" onClick={initializeEmptyDirectory}>Initialize Git</button>
            <div className="checkout-action">
              <input value={checkoutRemote} onChange={event => setCheckoutRemote(event.target.value)} placeholder="Remote repository URL" />
              <button className="primary" disabled={!checkoutRemote.trim()} onClick={checkoutEmptyDirectory}>Checkout here</button>
            </div>
          </div>
        </div>
      )}
      <ProjectToolbar {...{ directory, projects, choose, selectProject, removeProjectOption, active, stop, resume, defaultPathIcon }} />
      <RepositoryActionsBar {...{ directory, currentBranch, gitLfs, onBranchSwitch, incomingCommits, outgoingCommits, hasCommits, selected, aiBusy, gitBusy, generateCommitMessage, runGitRemote, requestPush, requestRevert }} showPull showPush showCommit showAmend={hasCommits} showStash showRevert />
      <FilesTable {...{ changes, query, selected, expanded, toggleFolder, toggleSelection, expandAllFolders, collapseAllFolders, openDiff, outgoingCommits, gitBusy, runGitRemote }} onQueryChange={setQuery} />
    </div>
  )
}
