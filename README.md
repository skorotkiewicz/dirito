# dev-shell

A browser workspace for a local directory: files, a text editor, an interactive terminal, and an app preview.

Requires Bun 1.3.5 or newer with `Bun.Terminal` support. A shell must be installed.

```sh
bunx dev-shell dir/
bunx dev-shell --watch dir/
bunx dev-shell dir/ --watch --proxy /api=http://localhost:3001
```

The browser opens automatically. Use `--no-open` to print the URL without opening it, and `--port 4000` to change the workspace port. `--port 0` chooses an available port. The executable uses a Bun shebang, so no `--bun` flag is needed.

For local development, run `bun install` followed by `bun index.ts dir/ --watch`. You can also run `bun link` to make `dev-shell` available locally.

## Workspace

- Browse files, create files and folders, rename items, and delete files or empty folders with explicit path confirmation. Use the arrow beside a folder to enter it, or double-click its name.
- Edit UTF-8 text files up to 1 MiB. Save with Ctrl+S or Cmd+S. Unsaved changes trigger a discard warning. Saves use a temporary file and refuse stale versions instead of silently overwriting disk changes.
- Use the real shell to install dependencies, run Git, set environment variables, and start development commands. Terminal apps, colors, keyboard shortcuts, and resizing work through a PTY and xterm.js. Closing the page ends its terminal session.
- Preview static files from the directory on a separate localhost port. The root serves `index.html`. Enable watching in Settings or pass `--watch` for HTML live reload. File changes appear in the bottom bar; `.git` and `node_modules` changes are ignored.
- Configure one HTTP proxy in Settings or with `--proxy`. `/api=http://localhost:3001` forwards `/api/users` to `http://localhost:3001/api/users`. The path prefix is retained. Use `/=http://localhost:5173` to preview a framework dev server that you start in the terminal.

The editor is a plain text editor, not a language server. Proxying is HTTP only, so upstream WebSocket HMR is not forwarded. Use the framework's own URL for its HMR, or Reload in the preview. Renames never overwrite existing destinations. Non-empty folders must be cleaned up deliberately in the terminal.

## Security

Both servers bind to `127.0.0.1`. The private workspace URL contains a random access token. File and terminal APIs require it and reject foreign browser origins. Project previews run on a separate port in a sandboxed iframe, without the workspace token. Paths and symlinks cannot escape the selected directory through file APIs; preview serving also blocks `.git` and `.env` paths.

The terminal is **not sandboxed**. Commands have your user's permissions and can access files outside the directory. Only open trusted projects. Keep the private workspace URL secret and do not expose either server through a tunnel or reverse proxy. The static preview serves other workspace files to local clients.

```sh
bun test
bun run typecheck
```
