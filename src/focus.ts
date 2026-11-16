/**
 * Brings the terminal running OpenCode back to the user when a notification is
 * clicked.
 *
 * KWin has no public "activate the window of this pid" call, so the module
 * generates a small KWin script and runs it through `org.kde.KWin /Scripting`.
 * The script unminimizes the window, switches to its Plasma Activity and
 * virtual desktop, then raises and activates it. This also works on Wayland,
 * where xdotool and wmctrl cannot be used.
 *
 * The terminal is located through the process ancestry of the TUI (and of the
 * tmux client when tmux is involved), then matched against `Window.pid`.
 */

import type { FileSystem } from './desktop.ts';
import type { ExecFile, Log } from './notify.ts';

export const ACTION_LABEL = 'Focus terminal';

const MAX_DEPTH = 32;
const KWIN_DEST = 'org.kde.KWin';
const SCRIPTING_PATH = '/Scripting';
const SCRIPTING_INTERFACE = 'org.kde.kwin.Scripting';
const SCRIPT_INTERFACE = 'org.kde.kwin.Script';

export interface Environment {
  readonly TMUX?: string;
  readonly TMUX_PANE?: string;
  readonly KITTY_PID?: string;
  readonly XDG_CURRENT_DESKTOP?: string;
  readonly KDE_FULL_SESSION?: string;
  readonly XDG_RUNTIME_DIR?: string;
}

export interface FocusOptions {
  readonly exec: ExecFile;
  readonly fs: FileSystem;
  readonly env: Environment;
  /** Process whose ancestry contains the terminal (the TUI process). */
  readonly pid: number;
  readonly parentPid: (pid: number) => number | undefined;
  /** Temporary directory used when `XDG_RUNTIME_DIR` is missing. */
  readonly tmpdir: string;
  readonly log: Log;
  /** Extra command run after the built-in KWin step. */
  readonly command?: string;
  /** Distinguishes concurrent plugin instances; defaults to the pid. */
  readonly tag?: string;
}

export interface Focuser {
  /** Fire-and-forget: failures are logged, never thrown. */
  focus(): void;
  dispose(): void;
}

interface Outcome {
  readonly error: Error | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Whether this session can be driven through KWin scripting. */
export function isKdeSession(env: Environment): boolean {
  if (env.KDE_FULL_SESSION === 'true') return true;
  return (env.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .some((name) => name.trim().toUpperCase() === 'KDE');
}

/** Walks `pid` and its parents, stopping at init or on a cycle. */
export function ancestorPids(
  pid: number,
  parentPid: (pid: number) => number | undefined,
  limit = MAX_DEPTH,
): number[] {
  const pids: number[] = [];
  const seen = new Set<number>();
  let current: number | undefined = pid;
  while (current !== undefined && current > 1 && pids.length < limit && !seen.has(current)) {
    seen.add(current);
    pids.push(current);
    current = parentPid(current);
  }
  return pids;
}

function parsePid(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const pid = Number(value.trim());
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

async function run(exec: ExecFile, command: string, args: readonly string[]): Promise<Outcome> {
  return new Promise((resolve) => {
    try {
      exec(command, args, (error, stdout, stderr) => {
        resolve({ error, stdout: stdout ?? '', stderr: stderr ?? '' });
      });
    } catch (error) {
      resolve({ error: error as Error, stdout: '', stderr: '' });
    }
  });
}

async function tmuxClientPids(exec: ExecFile): Promise<number[]> {
  const current = await run(exec, 'tmux', ['display-message', '-p', '#{client_pid}']);
  if (!current.error) {
    const pid = parsePid(current.stdout);
    if (pid !== undefined) return [pid];
  }

  const clients = await run(exec, 'tmux', ['list-clients', '-F', '#{client_pid}']);
  if (clients.error) return [];
  const pids: number[] = [];
  for (const line of clients.stdout.split('\n')) {
    const pid = parsePid(line);
    if (pid !== undefined) pids.push(pid);
  }
  return pids;
}

/**
 * Candidate pids for the terminal window: the TUI's ancestry, the tmux client's
 * ancestry (tmux daemonizes, so the TUI no longer descends from the terminal),
 * and `KITTY_PID` as a direct hint.
 */
export async function resolveTerminalPids(options: {
  readonly pid: number;
  readonly env: Environment;
  readonly exec: ExecFile;
  readonly parentPid: (pid: number) => number | undefined;
}): Promise<number[]> {
  const pids = new Set<number>();
  const addChain = (start: number | undefined): void => {
    if (start === undefined) return;
    for (const pid of ancestorPids(start, options.parentPid)) pids.add(pid);
  };

  addChain(options.pid);
  addChain(parsePid(options.env.KITTY_PID));

  if (options.env.TMUX) {
    for (const pid of await tmuxClientPids(options.exec)) addChain(pid);
  }

  return [...pids];
}

/**
 * Builds the throwaway KWin script. Pids are numbers, so nothing the user wrote
 * can leak into the script source.
 */
export function buildKwinScript(pids: readonly number[]): string {
  return [
    '(function () {',
    `  var pids = [${pids.join(', ')}];`,
    '  var windows = (typeof workspace.windowList === "function") ? workspace.windowList() : workspace.stackingOrder;',
    '  var matches = [];',
    '  for (var i = 0; i < windows.length; ++i) {',
    '    var w = windows[i];',
    '    if (!w || w.deleted || w.dock || w.desktopWindow || w.notification || w.popupWindow || w.splash) continue;',
    '    for (var p = 0; p < pids.length; ++p) {',
    '      if (w.pid === pids[p]) { matches.push(w); break; }',
    '    }',
    '  }',
    '  if (matches.length === 0) return;',
    '  var target = matches[matches.length - 1];',
    '  for (var a = 0; a < matches.length; ++a) {',
    '    if (matches[a].active) { target = matches[a]; break; }',
    '  }',
    '  try { if (workspace.showingDesktop) workspace.slotToggleShowDesktop(); } catch (e) {}',
    '  try { if (target.minimized) target.minimized = false; } catch (e) {}',
    '  try {',
    '    var activities = target.activities || [];',
    '    var onActivity = activities.length === 0;',
    '    for (var i2 = 0; i2 < activities.length; ++i2) {',
    '      if (activities[i2] === workspace.currentActivity) onActivity = true;',
    '    }',
    '    if (!onActivity) workspace.currentActivity = activities[0];',
    '  } catch (e) {}',
    '  try {',
    '    var desktops = target.desktops || [];',
    '    if (desktops.length > 0) {',
    '      var desktop = desktops[0];',
    '      var current = null;',
    '      try {',
    '        current = (target.output && typeof workspace.currentDesktopForScreen === "function")',
    '          ? workspace.currentDesktopForScreen(target.output)',
    '          : workspace.currentDesktop;',
    '      } catch (e2) {}',
    '      if (!current || current.id !== desktop.id) {',
    '        if (target.output && typeof workspace.setCurrentDesktopForScreen === "function") {',
    '          workspace.setCurrentDesktopForScreen(desktop, target.output);',
    '        } else {',
    '          workspace.currentDesktop = desktop;',
    '        }',
    '      }',
    '    }',
    '  } catch (e) {}',
    '  try { workspace.raiseWindow(target); } catch (e) {}',
    '  try { workspace.activeWindow = target; } catch (e) {}',
    '})();',
    '',
  ].join('\n');
}

/** Parses the `(N,)` reply from `org.kde.kwin.Scripting.loadScript`. */
export function parseScriptId(stdout: string): number | undefined {
  const match = /\(\s*(?:[A-Za-z0-9]+\s+)?(-?\d+)\s*,?\s*\)/.exec(stdout);
  if (!match?.[1]) return undefined;
  const id = Number(match[1]);
  return Number.isInteger(id) && id >= 0 ? id : undefined;
}

function gdbusArgs(path: string, method: string, params: readonly string[] = []): string[] {
  return [
    'call',
    '--session',
    '--dest',
    KWIN_DEST,
    '--object-path',
    path,
    '--method',
    method,
    ...params,
  ];
}

async function gdbus(
  exec: ExecFile,
  path: string,
  method: string,
  params: readonly string[] = [],
): Promise<Outcome> {
  return run(exec, 'gdbus', gdbusArgs(path, method, params));
}

async function selectTmuxPane(exec: ExecFile, env: Environment, log: Log): Promise<void> {
  if (!env.TMUX || !env.TMUX_PANE) return;
  const window = await run(exec, 'tmux', ['select-window', '-t', env.TMUX_PANE]);
  if (window.error) log('[kde-notify] could not select the tmux window', window.error);
  const pane = await run(exec, 'tmux', ['select-pane', '-t', env.TMUX_PANE]);
  if (pane.error) log('[kde-notify] could not select the tmux pane', pane.error);
}

async function activateWindow(
  options: FocusOptions,
  directory: string,
  tag: string,
  pids: readonly number[],
): Promise<void> {
  const name = `opencode-kde-notify-${tag}`;
  const file = `${directory}/focus-${tag}.js`;

  try {
    options.fs.makeDirectory(directory);
    options.fs.writeFile(file, buildKwinScript(pids));
  } catch (error) {
    options.log('[kde-notify] could not write the KWin focus script', error);
    return;
  }

  try {
    const loaded = await gdbus(options.exec, SCRIPTING_PATH, `${SCRIPTING_INTERFACE}.loadScript`, [
      file,
      name,
    ]);
    const id = loaded.error ? undefined : parseScriptId(loaded.stdout);
    if (id === undefined) {
      if ((loaded.error as { code?: string } | null)?.code === 'ENOENT') {
        options.log('[kde-notify] gdbus not found; click-to-focus unavailable');
      } else {
        options.log(
          `[kde-notify] could not load the KWin focus script: ${loaded.error?.message ?? loaded.stderr.trim()}`,
        );
      }
      return;
    }

    const scriptPath = `${SCRIPTING_PATH}/Script${id}`;
    await gdbus(options.exec, scriptPath, `${SCRIPT_INTERFACE}.run`);
    await gdbus(options.exec, scriptPath, `${SCRIPT_INTERFACE}.stop`);
    await gdbus(options.exec, SCRIPTING_PATH, `${SCRIPTING_INTERFACE}.unloadScript`, [name]);
  } catch (error) {
    options.log('[kde-notify] KWin focus failed', error);
  } finally {
    try {
      options.fs.removeFile(file);
    } catch {
      // Best effort.
    }
  }
}

async function runCommand(exec: ExecFile, command: string, log: Log): Promise<void> {
  const result = await run(exec, 'sh', ['-c', command]);
  if (result.error) {
    log(`[kde-notify] focus command failed: ${result.error.message}`, result.error);
  }
}

export function createFocuser(options: FocusOptions): Focuser {
  const runtimeDirectory = (options.env.XDG_RUNTIME_DIR || options.tmpdir).replace(/\/+$/, '');
  const directory = `${runtimeDirectory}/opencode-kde-notify`;
  const baseTag = options.tag ?? String(options.pid);
  let sequence = 0;
  let disposed = false;

  const focus = async (): Promise<void> => {
    try {
      await selectTmuxPane(options.exec, options.env, options.log);

      if (isKdeSession(options.env)) {
        const pids = await resolveTerminalPids({
          pid: options.pid,
          env: options.env,
          exec: options.exec,
          parentPid: options.parentPid,
        });
        if (pids.length > 0) {
          sequence += 1;
          await activateWindow(options, directory, `${baseTag}-${sequence}`, pids);
        }
      }
    } catch (error) {
      options.log('[kde-notify] could not focus the terminal', error);
    }

    if (options.command) {
      try {
        await runCommand(options.exec, options.command, options.log);
      } catch (error) {
        options.log('[kde-notify] focus command failed', error);
      }
    }
  };

  return {
    focus() {
      if (disposed) return;
      void focus();
    },
    dispose() {
      disposed = true;
    },
  };
}
