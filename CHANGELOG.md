# Changelog

All notable changes to OtherSSH are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- New look for the Other family: the dragon red OtherSSH icon, and slate, chalk and red in place of
  the old teal and navy, in the window, the terminal's background, cursor and selection, and the
  Gwyn empty state. Errors now sit on a tinted panel with a warning sign, so they don't read as
  ordinary red accents. The dot on a tab Claude is typing into is now amber, to stand apart from the
  red activity dot.

## [0.3.0] - 2026-11-23

### Added
- Claude can use OtherSSH through MCP. Turn it on in Settings ("Let Claude use OtherSSH"); the
  running app then serves MCP on 127.0.0.1 only, behind a random token, and Settings copies the
  `claude mcp add` command for you. Claude can list saved sessions and open tabs, open a tab you
  can watch, read a tab's screen, type into it, run a background command, upload files and close
  tabs, but only on sessions with the new "Allow Claude" box ticked. A tab's dot turns orange
  while Claude types into it, and Settings lists Claude's recent actions. "How to connect Claude" in
  Settings walks through it.

## [0.2.0] - 2026-11-11

### Added
- Drag and drop uploads: drop files or folders from Explorer onto a terminal and they're copied
  with scp into the folder the shell is in, using the tab's own profile. If OtherSSH can't be
  sure of the folder it asks first, with a best guess filled in.
- "Teach server to report its folder" on the tab menu adds a short prompt hook to the server's
  ~/.bashrc, so drops go straight to the current folder. Only folder reports carrying the
  session's own token are trusted, so text printed in the terminal can't redirect an upload.
- Uploads into a folder that needs root are parked in ~/.otherssh-upload, and a sudo mv is typed
  into the terminal, unsent, to finish them.
- Automatic updates from the Otherworld Services feed, checked every four hours and installed
  quietly when OtherSSH is closed, or while you're away with no connections open. Settings has
  the update mode, a beta channel, "Check for updates" and "Restart now". Every download is
  checked against OtherSSH's signing key before it's installed.

### Changed
- SSHIT is now called OtherSSH, with a new icon and the Otherworld colours. Saved sessions and
  settings are carried over on first start.

[0.3.0]: https://github.com/otherworld-dev/OtherSSH/releases/tag/v0.3.0
[0.2.0]: https://github.com/otherworld-dev/OtherSSH/releases/tag/v0.2.0
