# SSHIT

**SSH Is This.** Correct. It runs the `ssh` that was already on your machine and
puts a sidebar next to it.

It remembers your sessions, uses the keys and agent you already have, keeps tabs
that can be pulled into their own window, and does copy/paste without an
opinion. Anything not listed above was considered and declined.

It does not implement SSH itself: it drives the OS OpenSSH client (`ssh.exe`)
inside a real pseudo-terminal, so your `~/.ssh/config` aliases, `ssh-agent`,
`known_hosts` prompts, key passphrases and `ProxyJump` all behave exactly as they
do in a terminal. No credentials are ever stored by SSHIT.

## Features

- **Saved sessions** — name, host (or a `~/.ssh/config` alias), user, port,
  optional key file, and freeform extra ssh args. Stored as plain JSON; never any
  secrets.
- **Groups** — give a session a group name and it files under a collapsible
  header in the sidebar. Groups are flat and free-text; type a new name to
  create one, and a group disappears when its last session leaves it. The filter
  box matches group names too.
- **Your keys and agent** — connections go through the Windows System32 OpenSSH
  build, which is the one wired to the `ssh-agent` service. Agent keys, `-i` key
  files and passphrase prompts all just work.
- **Tabs, and tear-off windows** — many sessions in one window; right-click a tab
  to move it to a new window or another window, scrollback and all. A background
  tab's dot turns blue when it produces output, so you can tell a long job
  finished.
- **Quick connect** — type `user@host` (or `host:2222`, or a config alias) in
  the filter box and press Enter. Nothing is saved.
- **Import from `~/.ssh/config`** — one button adds a session for every `Host`
  alias you don't already have, filed under an "ssh config" group. The alias is
  used as the host, so ssh still reads the config itself.
- **Small comforts** — right-click a session for Connect / Edit / Duplicate /
  Delete; Ctrl+click opens URLs; Ctrl+wheel (or Ctrl+= / Ctrl+- / Ctrl+0) zooms
  one terminal; the window remembers its size and position.
- **Copy / paste that stays out of the way** — `Ctrl+Shift+C` copies the
  selection, `Ctrl+Shift+V` pastes, and right-click does whichever makes sense
  (copy if something is selected, paste if not). Plain `Ctrl+C` still sends an
  interrupt to the remote shell.

## Keyboard

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy selection / paste |
| Right-click in the terminal | Copies the selection if there is one, otherwise pastes |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+PgDn` / `Ctrl+PgUp` | Next / previous tab |
| `Ctrl+Shift+W` | Close tab |
| `Ctrl+Shift+B` | Toggle the sidebar |
| `Ctrl+wheel`, `Ctrl+=` / `Ctrl+-`, `Ctrl+0` | Zoom this terminal in / out / reset |
| `Ctrl+click` on a URL | Open it in the browser |
| Right-click a tab | Move to new / another window, or close |
| Right-click a session | Connect, Edit, Duplicate, Delete |
| Enter in the filter box | Connect to the first match, or to `user@host` typed there |
| In a closed tab | `Enter` closes it, `r` reconnects |

## Develop

```sh
npm install      # node-pty ships prebuilt binaries; nothing is compiled
npm run dev      # electron-vite dev server with reload
npm test         # vitest unit tests (the pure logic)
npm run typecheck
```

## Build

```sh
npm run dist:dir   # unpacked app in dist/win-unpacked (good for a quick check)
npm run dist       # dir + NSIS installer
```

`node-pty` is a native module. It is kept out of the Vite bundle
(`externalizeDepsPlugin`) and unpacked from the asar (`asarUnpack` in
`electron-builder.yml`) so its `pty.node` and the ConPTY helpers ship as real
files. No rebuild step is needed because the module is N-API with prebuilt
binaries (`npmRebuild: false`).

## Layout

```
src/shared/    types (the IPC contract), profile + arg helpers  (unit-tested)
src/main/      Electron main: ssh spawn, session ownership, windows, stores, IPC
src/preload/   contextBridge API exposed to the renderer
src/renderer/  vanilla-TS UI: sidebar, tabs, xterm terminals, dialogs
```

The main process owns every ssh process; renderer windows are just views, which is
what lets a live session move between windows. See
`docs/superpowers/specs/2026-09-06-sshit-design.md` for the full design.
```
