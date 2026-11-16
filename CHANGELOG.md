# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-16

### Added

- Clicking a notification brings the terminal running OpenCode back: it leaves "show desktop",
  unminimizes the window, switches to its Plasma Activity and virtual desktop, raises and focuses
  it, also on another monitor (KWin scripting over D-Bus; Wayland and X11).
- The matching OpenCode session tab is focused on click; under tmux the pane's window is selected
  too.
- `focusOnClick` option and `OPENCODE_KDE_NOTIFY_FOCUS_ON_CLICK` environment variable (default
  `true`).
- `focusCommand` option and `OPENCODE_KDE_NOTIFY_FOCUS_COMMAND` environment variable for exact
  window selection or desktops without KWin scripting.
- `CHANGELOG.md`.

### Changed

- Notifications carry a hidden `default` action; a short-lived `notify-send --wait` child receives
  the click and exits with the bubble.
- Click support degrades gracefully: notifications stay non-interactive when libnotify is older
  than 0.8, when the server lacks action support, or when the session is not KDE.
- Rapid clicks are coalesced into one focus run, and click waiters are stopped when OpenCode exits,
  so no orphaned processes or temporary focus scripts are left behind.

## [0.1.1] - 2026-11-16

### Added

- Desktop-entry identity so Plasma keeps notifications in its history.

[unreleased]: https://github.com/tiagosantini/opencode-kde-notify/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/tiagosantini/opencode-kde-notify/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/tiagosantini/opencode-kde-notify/releases/tag/v0.1.1
