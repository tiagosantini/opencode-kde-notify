import type { Plugin } from '@opencode/plugin/tui';

import { readSettings, shouldActivate, type When } from './config.ts';
import { ensureDesktopEntry, type FileSystem } from './desktop.ts';
import {
  ACTION_LABEL,
  isKdeSession,
  type Environment as FocusEnvironment,
  type Focuser,
} from './focus.ts';
import {
  compact,
  createSender,
  type ExecFile,
  type Log,
  type Notice,
  type Spawn,
} from './notify.ts';

type Context = Plugin.Context;

export interface FocusOptions {
  readonly env: FocusEnvironment;
  readonly command?: string;
  readonly log: Log;
}

export interface Runtime {
  /** Injected executor, used for tmux and KWin's D-Bus calls. */
  readonly exec: ExecFile;
  /** Injected child process factory, used for the click-aware `notify-send`. */
  readonly spawn: Spawn;
  readonly log?: Log;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected file access, used to install `opencode.desktop` and focus scripts. */
  readonly fs?: FileSystem;
  /** Builds the terminal focuser; omitted when the platform cannot provide one. */
  readonly createFocus?: (options: FocusOptions) => Focuser;
}

export type Cleanup = () => void;

const FALLBACK_TITLE = 'OpenCode';

function sessionInfo(ctx: Context, sessionID: string) {
  try {
    return ctx.data.session.get(sessionID);
  } catch {
    return undefined;
  }
}

/** Subagents are noisy: only the root session notifies. */
export function isSubagent(ctx: Context, sessionID: string): boolean {
  const info = sessionInfo(ctx, sessionID);
  if (info) return info.parentID !== undefined;
  try {
    return ctx.data.session.root(sessionID) !== sessionID;
  } catch {
    return false;
  }
}

export function sessionTitle(ctx: Context, sessionID: string): string {
  return compact(sessionInfo(ctx, sessionID)?.title, FALLBACK_TITLE);
}

/**
 * Selects the session that produced the notification inside the TUI. Falls back
 * to navigation when tabs are disabled or the session has no tab.
 */
export function focusSession(ctx: Context, sessionID: string): void {
  try {
    const ui = ctx.ui as typeof ctx.ui | undefined;
    if (ui?.tabs?.focus(sessionID)) return;
    ui?.router?.navigate({ type: 'session', sessionID });
  } catch {
    // The TUI may already be gone.
  }
}

/**
 * Uses the native attention API as a focus probe. It only skips when the focus
 * is known (`focused`) or when the user turned notifications off; on
 * `focus_unknown` it notifies anyway, so events are never lost.
 */
export async function isFocused(ctx: Context, notice: Notice, when: When): Promise<boolean> {
  if (when === 'always') return false;
  try {
    const result = await ctx.attention.notify({
      title: notice.title,
      message: notice.body,
      notification: { when: 'blurred' },
      sound: false,
    });
    return result.skipped === 'focused' || result.skipped === 'attention_disabled';
  } catch {
    return false;
  }
}

export function start(ctx: Context, runtime: Runtime): Cleanup | undefined {
  const env = runtime.env ?? process.env;
  const settings = readSettings(ctx.options, env);
  const log: Log =
    runtime.log ??
    ((message, error) => {
      if (error === undefined) console.error(message);
      else console.error(message, error);
    });

  if (!shouldActivate(settings, env)) {
    log('[kde-notify] kitty without tmux: native OSC 99 notifications already work');
    return;
  }

  if (settings.desktopEntry && runtime.fs) {
    ensureDesktopEntry(runtime.fs, env, log);
  }

  const focuser =
    settings.focusOnClick &&
    (isKdeSession(env) || Boolean(settings.focusCommand)) &&
    runtime.createFocus
      ? runtime.createFocus({ env, command: settings.focusCommand, log })
      : undefined;
  const action = focuser ? ACTION_LABEL : undefined;
  const sender = createSender(runtime.spawn, log);

  const dispatch = (notice: Notice, sessionID: string): void => {
    void (async () => {
      try {
        if (await isFocused(ctx, notice, settings.when)) return;
        sender.send(action ? { ...notice, action } : notice, () => {
          focuser?.focus();
          focusSession(ctx, sessionID);
        });
      } catch (error) {
        log('[kde-notify] failed to notify', error);
      }
    })();
  };

  const unsubscribe = [
    // Question asked in the harness (form waiting for an answer)
    ctx.data.on('form.created', (event) => {
      const form = event.data.form;
      if (isSubagent(ctx, form.sessionID)) return;
      dispatch(
        {
          title: 'OpenCode Question',
          body: `${sessionTitle(ctx, form.sessionID)}: ${compact(form.title, 'Reply in the terminal')}`,
          icon: 'dialog-question',
          urgency: 'critical',
          expire: 0,
        },
        form.sessionID,
      );
    }),

    // Work finished
    ctx.data.on('session.execution.succeeded', (event) => {
      const sessionID = event.data.sessionID;
      if (isSubagent(ctx, sessionID)) return;
      dispatch(
        {
          title: 'Task completed',
          body: sessionTitle(ctx, sessionID),
          icon: 'dialog-information',
          urgency: 'normal',
          expire: 8000,
        },
        sessionID,
      );
    }),

    // Execution failed
    ctx.data.on('session.execution.failed', (event) => {
      const sessionID = event.data.sessionID;
      if (isSubagent(ctx, sessionID)) return;
      dispatch(
        {
          title: 'Execution failed',
          body: `${sessionTitle(ctx, sessionID)}: ${compact(event.data.error.message, 'Unknown error')}`,
          icon: 'dialog-error',
          urgency: 'critical',
          expire: 0,
        },
        sessionID,
      );
    }),

    // Execution interrupted
    ctx.data.on('session.execution.interrupted', (event) => {
      const sessionID = event.data.sessionID;
      if (isSubagent(ctx, sessionID)) return;
      dispatch(
        {
          title: 'Execution interrupted',
          body: sessionTitle(ctx, sessionID),
          icon: 'process-stop',
          urgency: 'normal',
          expire: 8000,
        },
        sessionID,
      );
    }),

    // Permission waiting for a decision
    ctx.data.on('permission.asked', (event) => {
      const { sessionID, action: permissionAction, resources, message } = event.data;
      if (isSubagent(ctx, sessionID)) return;
      const detail = message ?? `${permissionAction}: ${resources[0] ?? 'resource'}`;
      dispatch(
        {
          title: 'Permission required',
          body: `${sessionTitle(ctx, sessionID)}: ${compact(detail, permissionAction)}`,
          icon: 'dialog-password',
          urgency: 'critical',
          expire: 0,
        },
        sessionID,
      );
    }),
  ];

  return () => {
    for (const off of unsubscribe) off();
    sender.dispose();
    focuser?.dispose();
  };
}
