import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { start, type FocusOptions, type Runtime } from '../src/plugin.ts';
import { ACTION_LABEL } from '../src/focus.ts';
import { DESKTOP_FILE, desktopFileContent } from '../src/desktop.ts';
import type { ChildProcessHandle } from '../src/notify.ts';

type Ctx = Parameters<typeof start>[0];

interface FakeSession {
  title?: string;
  parentID?: string;
}

interface HarnessOptions {
  readonly skip?: string;
  readonly options?: Record<string, unknown>;
  readonly env?: Record<string, string | undefined>;
  readonly sessions?: Record<string, FakeSession>;
  readonly files?: Record<string, string>;
  readonly failWrites?: boolean;
  readonly focusRuntime?: boolean;
  readonly tabs?: boolean;
}

const TMUX_WITH_KITTY = {
  TMUX: '/tmp/tmux-1000/default,1,0',
  TMUX_PANE: '%0',
  KITTY_WINDOW_ID: '1',
  KITTY_PID: '15540',
  XDG_CURRENT_DESKTOP: 'KDE',
  HOME: '/home/user',
};

const DESKTOP_PATH = `/home/user/.local/share/applications/${DESKTOP_FILE}`;

class FakeChild {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  private readonly events = new EventEmitter();
  killed = false;

  on(event: string, listener: (...args: any[]) => void): this {
    this.events.on(event, listener);
    return this;
  }

  kill(): void {
    this.killed = true;
  }

  click(): void {
    this.stdout.emit('data', 'default\n');
  }
}

function harness(input: HarnessOptions = {}) {
  const handlers = new Map<string, (event: { data: unknown }) => void>();
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const sent: Array<{ command: string; args: readonly string[] }> = [];
  const children: FakeChild[] = [];
  const logs: string[] = [];
  const files = new Map(Object.entries(input.files ?? {}));
  const directories: string[] = [];
  const focusOptions: FocusOptions[] = [];
  const focused: string[] = [];
  const disposedFocusers: string[] = [];
  const tabCalls: string[] = [];
  const navigations: Array<{ type: string; sessionID?: string }> = [];
  const state = { skip: input.skip, probes: 0 };
  const sessions = input.sessions ?? {
    ses_root: { title: 'Fix the dashboard login' },
    ses_child: { title: 'Explore subagent', parentID: 'ses_root' },
  };

  const ctx = {
    options: input.options ?? {},
    data: {
      on(type: string, handler: (event: { data: unknown }) => void) {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
      session: {
        get: (id: string) => sessions[id],
        root: (id: string) => sessions[id]?.parentID ?? id,
      },
    },
    attention: {
      async notify() {
        state.probes += 1;
        return { ok: true, notification: false, sound: false, skipped: state.skip };
      },
    },
    ui: {
      tabs: {
        focus(sessionID: string) {
          tabCalls.push(sessionID);
          return input.tabs ?? true;
        },
      },
      router: {
        navigate(destination: { type: string; sessionID?: string }) {
          navigations.push(destination);
        },
      },
    },
  } as unknown as Ctx;

  const runtime: Runtime = {
    exec: (command, args, callback) => {
      calls.push({ command, args });
      callback(null);
    },
    spawn: (command, args) => {
      sent.push({ command, args });
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcessHandle;
    },
    log: (message) => {
      logs.push(message);
    },
    env: input.env ?? TMUX_WITH_KITTY,
    fs: {
      readFile: (path) => files.get(path),
      writeFile: (path, content) => {
        if (input.failWrites) throw new Error('EROFS: read-only file system');
        files.set(path, content);
      },
      makeDirectory: (path) => {
        directories.push(path);
      },
      removeFile: (path) => {
        files.delete(path);
      },
    },
    ...(input.focusRuntime === false
      ? {}
      : {
          createFocus: (options: FocusOptions) => {
            focusOptions.push(options);
            const id = options.command ?? 'builtin';
            return {
              focus() {
                focused.push(id);
              },
              dispose() {
                disposedFocusers.push(id);
              },
            };
          },
        }),
  };

  const fire = (type: string, data: unknown) => {
    const handler = handlers.get(type);
    if (!handler) throw new Error(`no handler registered for ${type}`);
    handler({ data });
  };

  return {
    ctx,
    runtime,
    handlers,
    calls,
    sent,
    children,
    logs,
    state,
    files,
    directories,
    focusOptions,
    focused,
    disposedFocusers,
    tabCalls,
    navigations,
    fire,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const hasAction = (args: readonly string[]) => args.includes(`--action=default=${ACTION_LABEL}`);

test('notifies question, completion, failure, interruption and permission', async () => {
  const h = harness({ skip: 'blurred' });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  h.fire('form.created', {
    form: { id: 'frm_1', sessionID: 'ses_root', title: 'Which database should I use?' },
  });
  h.fire('session.execution.succeeded', { sessionID: 'ses_root' });
  h.fire('session.execution.failed', {
    sessionID: 'ses_root',
    error: { type: 'api', message: 'Rate limit reached' },
  });
  h.fire('session.execution.interrupted', { sessionID: 'ses_root' });
  h.fire('permission.asked', {
    id: 'per_1',
    sessionID: 'ses_root',
    action: 'bash',
    resources: ['rm -rf build'],
  });
  await settle();

  assert.equal(h.sent.length, 5);
  assert.deepEqual(
    h.sent.map((call) => call.args.at(-2)),
    [
      'OpenCode Question',
      'Task completed',
      'Execution failed',
      'Execution interrupted',
      'Permission required',
    ],
  );
  assert.ok(h.sent.every((call) => call.command === 'notify-send'));
  assert.ok(h.sent.every((call) => hasAction(call.args)));
  assert.deepEqual(h.sent[0]?.args.slice(-1), [
    'Fix the dashboard login: Which database should I use?',
  ]);
  assert.deepEqual(h.sent[2]?.args.slice(-1), ['Fix the dashboard login: Rate limit reached']);

  cleanup();
});

test('ignores subagents', async () => {
  const h = harness({ skip: 'blurred' });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  h.fire('session.execution.succeeded', { sessionID: 'ses_child' });
  h.fire('form.created', { form: { id: 'frm_1', sessionID: 'ses_child', title: 'Confirm?' } });
  await settle();

  assert.equal(h.sent.length, 0);
  cleanup();
});

test('does not notify while the terminal is focused', async () => {
  const h = harness({ skip: 'focused' });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  h.fire('session.execution.succeeded', { sessionID: 'ses_root' });
  await settle();

  assert.equal(h.sent.length, 0);
  cleanup();
});

test('does not notify when notifications are turned off', async () => {
  const h = harness({ skip: 'attention_disabled' });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  h.fire('session.execution.succeeded', { sessionID: 'ses_root' });
  await settle();

  assert.equal(h.sent.length, 0);
  cleanup();
});

test('notifies when the focus is unknown', async () => {
  const h = harness({ skip: 'focus_unknown' });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  h.fire('session.execution.succeeded', { sessionID: 'ses_root' });
  await settle();

  assert.equal(h.sent.length, 1);
  cleanup();
});

test('when=always skips the focus probe', async () => {
  const h = harness({ skip: 'focused', options: { when: 'always' } });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  h.fire('session.execution.succeeded', { sessionID: 'ses_root' });
  await settle();

  assert.equal(h.state.probes, 0);
  assert.equal(h.sent.length, 1);
  cleanup();
});

test('clicking a bubble focuses the terminal and the session tab', async () => {
  const h = harness({ skip: 'blurred' });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  h.fire('session.execution.succeeded', { sessionID: 'ses_root' });
  await settle();
  assert.equal(h.focused.length, 0);

  h.children[0]?.click();
  await settle();

  assert.deepEqual(h.focused, ['builtin']);
  assert.deepEqual(h.tabCalls, ['ses_root']);
  assert.deepEqual(h.navigations, []);
  cleanup();
});

test('navigates to the session when tabs are disabled', async () => {
  const h = harness({ skip: 'blurred', tabs: false });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  h.fire('session.execution.succeeded', { sessionID: 'ses_root' });
  await settle();
  h.children[0]?.click();
  await settle();

  assert.deepEqual(h.tabCalls, ['ses_root']);
  assert.deepEqual(h.navigations, [{ type: 'session', sessionID: 'ses_root' }]);
  cleanup();
});

test('focusOnClick=false keeps notifications non-interactive', async () => {
  const h = harness({ skip: 'blurred', options: { focusOnClick: false } });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  h.fire('session.execution.succeeded', { sessionID: 'ses_root' });
  await settle();

  assert.equal(h.sent.length, 1);
  assert.ok(!h.sent[0]?.args.some((arg) => arg.startsWith('--action=')));
  assert.equal(h.focusOptions.length, 0);
  cleanup();
});

test('non-KDE sessions stay non-interactive without a focus command', async () => {
  const h = harness({ skip: 'blurred', env: { HOME: '/home/user' } });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  h.fire('session.execution.succeeded', { sessionID: 'ses_root' });
  await settle();

  assert.equal(h.sent.length, 1);
  assert.ok(!h.sent[0]?.args.some((arg) => arg.startsWith('--action=')));
  assert.equal(h.focusOptions.length, 0);
  cleanup();
});

test('a focus command makes notices clickable outside KDE', async () => {
  const h = harness({
    skip: 'blurred',
    env: { HOME: '/home/user' },
    options: { focusCommand: 'kitty @ focus-window' },
  });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  h.fire('session.execution.succeeded', { sessionID: 'ses_root' });
  await settle();

  assert.ok(hasAction(h.sent[0]?.args ?? []));
  assert.equal(h.focusOptions.length, 1);
  assert.equal(h.focusOptions[0]?.command, 'kitty @ focus-window');

  h.children[0]?.click();
  await settle();
  assert.deepEqual(h.focused, ['kitty @ focus-window']);
  cleanup();
});

test('stays non-interactive when the runtime cannot focus windows', async () => {
  const h = harness({ skip: 'blurred', focusRuntime: false });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  h.fire('session.execution.succeeded', { sessionID: 'ses_root' });
  await settle();

  assert.equal(h.sent.length, 1);
  assert.ok(!h.sent[0]?.args.some((arg) => arg.startsWith('--action=')));
  cleanup();
});

test('cleanup removes every handler and stops waiting for clicks', async () => {
  const h = harness({ skip: 'blurred' });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);
  assert.equal(h.handlers.size, 5);

  h.fire('session.execution.succeeded', { sessionID: 'ses_root' });
  await settle();

  cleanup();
  assert.equal(h.handlers.size, 0);
  assert.equal(h.children[0]?.killed, true);
  assert.deepEqual(h.disposedFocusers, ['builtin']);
});

test('stays inactive in kitty without tmux in auto mode', () => {
  const h = harness({ env: { KITTY_WINDOW_ID: '1' } });
  const cleanup = start(h.ctx, h.runtime);

  assert.equal(cleanup, undefined);
  assert.equal(h.handlers.size, 0);
  assert.match(h.logs[0] ?? '', /kitty without tmux/);
});

test('mode=always acts even in kitty without tmux', () => {
  const h = harness({ env: { KITTY_WINDOW_ID: '1' }, options: { mode: 'always' } });
  const cleanup = start(h.ctx, h.runtime);

  assert.ok(cleanup);
  assert.equal(h.handlers.size, 5);
});

test('installs the desktop entry so Plasma can attribute notifications', () => {
  const h = harness();
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  assert.deepEqual(h.directories, ['/home/user/.local/share/applications']);
  assert.equal(h.files.get(DESKTOP_PATH), desktopFileContent());
  cleanup();
});

test('desktopEntry=false leaves the filesystem untouched', () => {
  const h = harness({ options: { desktopEntry: false } });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  assert.deepEqual(h.directories, []);
  assert.equal(h.files.size, 0);
  cleanup();
});

test('a failing filesystem does not stop the notification', async () => {
  const h = harness({ failWrites: true, skip: 'blurred' });
  const cleanup = start(h.ctx, h.runtime);
  assert.ok(cleanup);

  h.fire('session.execution.succeeded', { sessionID: 'ses_root' });
  await settle();

  assert.equal(h.sent.length, 1);
  assert.match(h.logs.join('\n'), /could not write the desktop entry/);
  cleanup();
});
