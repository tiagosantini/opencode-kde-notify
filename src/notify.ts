/**
 * Notification building and delivery through `notify-send` (D-Bus).
 *
 * The module is pure: process execution is injected, which keeps the tests
 * independent from OpenCode and from the graphical session.
 *
 * Clickable notices carry a `default` action. Plasma invokes it when the bubble
 * body is clicked, and `notify-send` reports it on stdout; the child therefore
 * stays alive until the notification is dismissed or expires.
 */

import { DESKTOP_ENTRY } from './desktop.ts';

export type Urgency = 'low' | 'normal' | 'critical';

export interface Notice {
  readonly title: string;
  readonly body: string;
  readonly icon: string;
  readonly urgency: Urgency;
  /** Milliseconds; `0` keeps the bubble sticky on Plasma. */
  readonly expire: number;
  /** Label for the `default` action; omitted when the notice is not clickable. */
  readonly action?: string;
}

export const APP_NAME = 'OpenCode';
export const MAX_BODY = 220;

type ExecCallback = (error: Error | null, stdout?: string, stderr?: string) => void;
export type ExecFile = (command: string, args: readonly string[], callback: ExecCallback) => void;
export type Log = (message: string, error?: unknown) => void;

/** The slice of a Node child process the sender needs. */
export interface ChildProcessHandle {
  readonly stdout: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  } | null;
  readonly stderr: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  } | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(): void;
}

export type Spawn = (command: string, args: readonly string[]) => ChildProcessHandle;

/** Collapses whitespace and limits the text shown in the bubble. */
export function compact(value: string | undefined, fallback: string): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text;
}

export function buildArgs(notice: Notice): string[] {
  const args = [
    `--app-name=${APP_NAME}`,
    `--icon=${notice.icon}`,
    `--urgency=${notice.urgency}`,
    `--expire-time=${notice.expire}`,
    // Gives Plasma an identity to resolve; otherwise the notification lands in
    // the `@other` bucket, which is excluded from the history by default.
    `--hint=string:desktop-entry:${DESKTOP_ENTRY}`,
  ];
  if (notice.action) args.push(`--action=default=${notice.action}`);
  args.push(notice.title, notice.body);
  return args;
}

export interface Sender {
  /**
   * Shows the notification. `onActivate` runs once if the user clicks the
   * bubble body while it is visible.
   */
  send(notice: Notice, onActivate?: () => void): void;
  /** Stops waiting for clicks on notifications that are still visible. */
  dispose(): void;
}

const UNSUPPORTED_OPTION = /unknown option|unrecognized option|invalid option/i;
const UNSUPPORTED_ACTIONS = /actions are not supported/i;

/**
 * Creates the notification sender; failures never interrupt OpenCode.
 *
 * When the installed `notify-send` predates action support, the notification is
 * shown again without the action, so only the click goes missing.
 */
export function createSender(spawn: Spawn, log: Log = () => {}): Sender {
  const children = new Set<ChildProcessHandle>();
  let actionsSupported = true;
  let disposed = false;

  const activate = (handler: (() => void) | undefined): void => {
    if (!handler) return;
    try {
      handler();
    } catch (error) {
      log('[kde-notify] click handler failed', error);
    }
  };

  const launch = (notice: Notice, withAction: boolean, onActivate?: () => void): void => {
    let child: ChildProcessHandle;
    try {
      child = spawn(
        'notify-send',
        buildArgs(withAction ? notice : { ...notice, action: undefined }),
      );
    } catch (error) {
      log(`[kde-notify] notify-send failed: ${(error as Error).message}`, error);
      return;
    }

    children.add(child);
    let activated = false;
    let settled = false;
    let buffered = '';
    let stderr = '';

    const handleLine = (line: string): void => {
      if (disposed || activated || line !== 'default') return;
      activated = true;
      activate(onActivate);
    };

    child.stdout?.on('data', (chunk) => {
      buffered += String(chunk);
      for (;;) {
        const index = buffered.indexOf('\n');
        if (index < 0) break;
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        handleLine(line);
      }
    });

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      children.delete(child);
      if ((error as { code?: string }).code === 'ENOENT') {
        log('[kde-notify] notify-send not found; notification skipped');
        return;
      }
      log(`[kde-notify] notify-send failed: ${error.message}`, error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      children.delete(child);
      handleLine(buffered.trim());

      if (withAction && !activated && code !== 0 && UNSUPPORTED_OPTION.test(stderr)) {
        actionsSupported = false;
        log('[kde-notify] notify-send without action support; notifications stay non-interactive');
        launch(notice, false);
        return;
      }
      if (code !== null && code !== 0 && !UNSUPPORTED_ACTIONS.test(stderr)) {
        log(`[kde-notify] notify-send exited with code ${code}`);
      }
    });
  };

  return {
    send(notice, onActivate) {
      if (disposed) return;
      launch(notice, actionsSupported && Boolean(notice.action), onActivate);
    },
    dispose() {
      disposed = true;
      for (const child of children) {
        try {
          child.kill();
        } catch {
          // The child may already be gone.
        }
      }
      children.clear();
    },
  };
}
