/**
 * Desktop-entry identity for notifications.
 *
 * Plasma attributes a notification by its `desktop-entry` hint, which it then
 * resolves against an installed `.desktop` file. Without a resolvable entry the
 * notification falls into the `@other` bucket, and Plasma ships that bucket with
 * `ShowInHistory=false` — the bubble shows up, but the notification never
 * reaches the history widget in the system tray.
 */

export const DESKTOP_ENTRY = 'opencode';
export const DESKTOP_FILE = `${DESKTOP_ENTRY}.desktop`;

/** Marks the file as ours, so an unrelated `opencode.desktop` is never touched. */
export const MARKER = 'X-OpenCode-KDE-Notify=true';

export interface FileSystem {
  /** Returns the file contents, or `undefined` when it cannot be read. */
  readFile(path: string): string | undefined;
  writeFile(path: string, content: string): void;
  makeDirectory(path: string): void;
  /** Removes a file; failures are ignored by callers. */
  removeFile(path: string): void;
}

export interface Environment {
  readonly XDG_DATA_HOME?: string;
  readonly HOME?: string;
}

export type Log = (message: string, error?: unknown) => void;

export interface Locations {
  readonly directory: string;
  readonly file: string;
}

/**
 * `NoDisplay` keeps the entry out of the application launcher: the file exists
 * only to give the notification an identity Plasma can resolve.
 */
export function desktopFileContent(): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=OpenCode',
    'Comment=AI coding agent notifications',
    'Exec=opencode',
    'Icon=utilities-terminal',
    'Terminal=true',
    'NoDisplay=true',
    'Categories=Development;',
    MARKER,
    '',
  ].join('\n');
}

/** `<XDG_DATA_HOME>/applications` (or `~/.local/share/applications`). */
export function desktopLocations(env: Environment): Locations | undefined {
  const dataHome = env.XDG_DATA_HOME || (env.HOME ? `${env.HOME}/.local/share` : undefined);
  if (!dataHome) return undefined;

  const directory = `${dataHome.replace(/\/+$/, '')}/applications`;
  return { directory, file: `${directory}/${DESKTOP_FILE}` };
}

function isOurs(content: string): boolean {
  return content.includes(MARKER);
}

/**
 * Writes the desktop entry when it is missing or when a previous version of
 * this plugin created it. Failures never interrupt notifications.
 */
export function ensureDesktopEntry(fs: FileSystem, env: Environment, log: Log = () => {}): void {
  const locations = desktopLocations(env);
  if (!locations) {
    log('[kde-notify] HOME is not set; desktop entry skipped');
    return;
  }

  const content = desktopFileContent();

  try {
    const existing = fs.readFile(locations.file);
    if (existing !== undefined) {
      if (existing === content || !isOurs(existing)) return;
    } else {
      fs.makeDirectory(locations.directory);
    }
    fs.writeFile(locations.file, content);
  } catch (error) {
    log('[kde-notify] could not write the desktop entry', error);
  }
}
