/**
 * Plugin configuration.
 *
 * Comes from `options` (the `{ package, options }` object form in
 * `opencode.json`/`cli.json`) or, when nothing is configured, from environment
 * variables.
 */

export type Mode = 'auto' | 'always';
export type When = 'blurred' | 'always';

export interface Settings {
  /** `auto`: act only where the native path (OSC 99) fails. `always`: always use D-Bus. */
  readonly mode: Mode;
  /** `blurred`: notify only while the terminal is unfocused. `always`: always notify. */
  readonly when: When;
  /** Write `opencode.desktop` so Plasma can attribute the notification. */
  readonly desktopEntry: boolean;
}

export interface Environment {
  readonly TMUX?: string;
  readonly KITTY_WINDOW_ID?: string;
  readonly OPENCODE_KDE_NOTIFY_MODE?: string;
  readonly OPENCODE_KDE_NOTIFY_WHEN?: string;
  readonly OPENCODE_KDE_NOTIFY_DESKTOP_ENTRY?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'auto',
  when: 'blurred',
  desktopEntry: true,
};

function parseMode(value: unknown): Mode | undefined {
  return value === 'auto' || value === 'always' ? value : undefined;
}

function parseWhen(value: unknown): When | undefined {
  return value === 'blurred' || value === 'always' ? value : undefined;
}

function parseDesktopEntry(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function readSettings(
  options: Readonly<Record<string, unknown>> | undefined,
  env: Environment = {},
): Settings {
  return {
    mode:
      parseMode(options?.mode) ?? parseMode(env.OPENCODE_KDE_NOTIFY_MODE) ?? DEFAULT_SETTINGS.mode,
    when:
      parseWhen(options?.when) ?? parseWhen(env.OPENCODE_KDE_NOTIFY_WHEN) ?? DEFAULT_SETTINGS.when,
    desktopEntry:
      parseDesktopEntry(options?.desktopEntry) ??
      parseDesktopEntry(env.OPENCODE_KDE_NOTIFY_DESKTOP_ENTRY) ??
      DEFAULT_SETTINGS.desktopEntry,
  };
}

/**
 * In `auto` mode the plugin stays inactive only when kitty runs outside tmux:
 * there the OSC 99 protocol reaches the terminal and OpenCode already notifies.
 * Inside tmux (or in any other terminal) OSC 99 is swallowed, so the plugin
 * takes over through D-Bus.
 */
export function shouldActivate(settings: Settings, env: Environment): boolean {
  if (settings.mode === 'always') return true;
  if (!env.KITTY_WINDOW_ID) return true;
  return Boolean(env.TMUX);
}
