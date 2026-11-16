# opencode-kde-notify

[![CI](https://github.com/tiagosantini/opencode-kde-notify/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tiagosantini/opencode-kde-notify/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Native KDE Plasma / freedesktop notifications for [OpenCode](https://opencode.ai) on Linux,
delivered straight to D-Bus through `notify-send`.

## Why this exists

OpenCode raises notifications through the terminal's OSC 99 protocol (`opentui-notifications`). Inside
`tmux` that sequence never reaches the terminal — tmux only forwards sequences wrapped in its
passthrough format — so no system bubble appears (the sound still plays, because it is generated
locally). This plugin bypasses the problem by talking to `org.freedesktop.Notifications` directly.

## Requirements

- OpenCode 2.x
- Linux with a freedesktop notification server (KDE Plasma, GNOME, dunst, mako, …)
- `notify-send` on `PATH` (`libnotify` / `libnotify-bin`)

## Installation

### As a local plugin (auto-discovered)

Copy or clone this directory into the global plugin folder:

```text
~/.config/opencode/plugins/opencode-kde-notify/
```

OpenCode discovers plugins under `<config>/plugins/<package>/` automatically — nothing to configure.

### From a repository outside the config directory

Point to the absolute path in `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/user/Projects/opencode-kde-notify"],
}
```

### From GitHub

```sh
opencode plugin add github:tiagosantini/opencode-kde-notify
```

### Published on npm

```sh
opencode plugin add opencode-kde-notify
```

## What gets notified

| Event                                | Title                 | Icon                 | Urgency          |
| ------------------------------------ | --------------------- | -------------------- | ---------------- |
| `form.created` (question in harness) | OpenCode Question     | `dialog-question`    | critical, sticky |
| `session.execution.succeeded`        | Task completed        | `dialog-information` | normal, 8 s      |
| `session.execution.failed`           | Execution failed      | `dialog-error`       | critical, sticky |
| `session.execution.interrupted`      | Execution interrupted | `process-stop`       | normal, 8 s      |
| `permission.asked`                   | Permission required   | `dialog-password`    | critical, sticky |

Subagent sessions are ignored — only the root session notifies. All user-facing strings live in
`src/plugin.ts`.

## Behavior

- **Focus:** the native attention API is used as a focus probe. A notification is skipped only when
  the focus is known (`focused`) or when notifications are turned off; on `focus_unknown` it still
  notifies, so events are never lost.
- **Sounds:** untouched. They keep coming from the built-in `opencode.notifications` plugin.
- **`auto` mode:** the plugin stays inactive when running inside kitty **without** tmux, because
  there OSC 99 reaches the terminal and OpenCode already notifies. Inside tmux (or in any other
  terminal) it takes over. This prevents duplicate bubbles.
- **Identity:** notifications carry a `desktop-entry=opencode` hint and the plugin installs
  `~/.local/share/applications/opencode.desktop` for it (see below).

## Notification history

Plasma only keeps a notification in the system tray history when it can attribute it to an
application: it resolves the `desktop-entry` hint against an installed `.desktop` file. A
notification without one falls into the `@other` bucket, and Plasma ships that bucket with
`ShowInHistory=false` — the bubble appears, the history stays empty. Plain `notify-send` has the
same fate.

That is why the plugin writes `opencode.desktop` into `$XDG_DATA_HOME/applications` (usually
`~/.local/share/applications`) on startup: it gives the notifications an identity Plasma can
resolve, so they land in the history with the default settings.

- The file is marked with `X-OpenCode-KDE-Notify=true`. It is only rewritten when the plugin
  created it; a real `opencode.desktop` installed by something else is never touched.
- `NoDisplay=true` keeps it out of the application launcher.
- Set `desktopEntry: false` (or `OPENCODE_KDE_NOTIFY_DESKTOP_ENTRY=false`) to stop the file from
  being written, or delete it — the notifications keep working, they just lose their history entry.
- Plasma keeps the history in memory only, so it is emptied whenever `plasmashell` restarts
  ([KDE bug 486483](https://bugs.kde.org/show_bug.cgi?id=486483)).

## Configuration

Options (all have sensible defaults — usually nothing to configure):

| Option         | Values              | Default   | Description                                                                  |
| -------------- | ------------------- | --------- | ---------------------------------------------------------------------------- |
| `mode`         | `auto`, `always`    | `auto`    | `auto` acts only where the native path fails; `always` uses D-Bus every time |
| `when`         | `blurred`, `always` | `blurred` | Notify only when the terminal is unfocused, or always                        |
| `desktopEntry` | `true`, `false`     | `true`    | Install `opencode.desktop` so notifications reach the Plasma history         |

Through configuration:

```jsonc
{
  "plugins": [
    {
      "package": "/home/user/Projects/opencode-kde-notify",
      "options": { "mode": "always", "when": "always" },
    },
  ],
}
```

Or through the environment, without editing configuration:

```sh
OPENCODE_KDE_NOTIFY_MODE=always
OPENCODE_KDE_NOTIFY_WHEN=always
OPENCODE_KDE_NOTIFY_DESKTOP_ENTRY=false
```

Environment variables are used only when the matching option is not set.

## Development

No dependencies required:

```sh
node --test test/*.test.ts        # 36 tests, Node 22.18+ (native type stripping)
```

With type checking:

```sh
npm install
npm run typecheck
```

### Layout

```text
src/
  index.ts    server part (package identity)
  tui.ts      TUI part (entrypoint loaded by OpenCode)
  plugin.ts   wiring: events → focus probe → notification
  config.ts   options, environment variables, terminal detection
  desktop.ts  desktop-entry identity and its installation
  notify.ts   argument building and notify-send execution
test/
  config.test.ts
  desktop.test.ts
  notify.test.ts
  plugin.test.ts
```

`plugin.ts` imports nothing from the OpenCode SDK at runtime (types only), and `exec` and the file
access are injected, so the tests run on plain Node.

## Disabling

Add the id to `plugins` in `cli.json`, prefixed with `-`:

```jsonc
{
  "plugins": ["-kde.notify"],
}
```

## Troubleshooting

- **Nothing shows up:** test D-Bus with
  `notify-send --app-name=OpenCode "test" "works?"`.
- **Bubble shows up, history stays empty:** check that
  `~/.local/share/applications/opencode.desktop` exists and that `plasmashell` has not restarted
  since the notification (the history is in memory only).
- **Plugin errors:** `~/.local/share/opencode/log/opencode.log` (look for `kde-notify`).
- **Plugin detection:** `opencode plugin list` should show `kde.notify`.
- **After structural changes:** run `/reload` in the TUI to reload plugins.
- **Anything else:** open an issue at
  [github.com/tiagosantini/opencode-kde-notify/issues](https://github.com/tiagosantini/opencode-kde-notify/issues).

## Contributing

Issues and pull requests are welcome at
[github.com/tiagosantini/opencode-kde-notify](https://github.com/tiagosantini/opencode-kde-notify).

```sh
node --test test/*.test.ts      # tests
npm run format:check   # formatting
npm run typecheck      # types, after `npm install`
```

## License

MIT — see [LICENSE](./LICENSE).
