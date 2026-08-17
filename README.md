# Pulse Git AI

Pulse Git AI is an Electron app for monitoring Git repositories and selecting the files involved in a commit.

It uses Ollama to split changes into focused commits and generate Conventional Commit messages from the selected diffs.

## Development

```bash
npm install
npm run dev
```

Configure the Ollama endpoint and model from `File → Settings…`.
