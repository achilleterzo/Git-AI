# Pulse Git AI

Pulse is an Electron desktop app for monitoring Git projects, selecting files to commit, and managing the Git workflow with Ollama.

## Key features

- Real-time directory monitoring through `fs.watch`.
- Git changes organized in a directory tree.
- File checkboxes and three-state directory checkboxes.
- Global selection of visible files from the table header.
- Selection persistence across watcher updates.
- Management of multiple recent projects, with confirmation before removal.
- `Pull` and `Push` buttons for the active repository.
- Indicates local commits that have not been pushed yet and shows a `Push` CTA when the working tree is clean.
- Persistent Ollama settings for endpoint, model, and message language.
- Loading available models through `/api/tags`.
- Conventional Commit message generation using the diff of selected files only.
- Editing the generated message before committing.
- Committing only selected files with `git add` and `git commit`.
- Automatic list refresh after commit, pull, and push.
- Error modals and AI generation retry support.
- Persistent window position, size, and maximized state.
- Dark charcoal desktop theme.

## Development

```bash
npm install
npm run dev
```

## Web build

```bash
npm run build
```

## Windows desktop build

```bash
npm run dist:desktop
```

The installer is generated in the `release` directory.

## Ollama

The default endpoint is `http://localhost:11434`. Open `File → Settings…`, configure the endpoint, load the models, and select the model to use for message generation.

## Technical notes

The Electron main process handles the filesystem, Git, Ollama, and IPC. The React renderer does not access the filesystem or system processes directly; it communicates through preload APIs exposed with `contextBridge`.
