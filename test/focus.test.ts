import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FileSystem } from '../src/desktop.ts';
import {
  ACTION_LABEL,
  ancestorPids,
  buildKwinScript,
  createFocuser,
  isKdeSession,
  parseScriptId,
  resolveTerminalPids,
  type Environment,
} from '../src/focus.ts';
import type { ExecFile } from '../src/notify.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function memoryFs() {
  const files = new Map<string, string>();
  const removed: string[] = [];
  const directories: string[] = [];
  const fs: FileSystem = {
    readFile: (path) => files.get(path),
    writeFile: (path, content) => {
      files.set(path, content);
    },
    makeDirectory: (path) => {
      directories.push(path);
    },
    removeFile: (path) => {
      files.delete(path);
      removed.push(path);
    },
  };
  return { fs, files, removed, directories };
}

interface ExecCall {
  readonly command: string;
  readonly args: readonly string[];
}

function recordingExec(
  handler: (call: ExecCall) => { error: Error | null; stdout?: string; stderr?: string } = () => ({
    error: null,
    stdout: '',
  }),
) {
  const calls: ExecCall[] = [];
  const exec: ExecFile = (command, args, callback) => {
    const call = { command, args };
    calls.push(call);
    const result = handler(call);
    callback(result.error, result.stdout ?? '', result.stderr ?? '');
  };
  return { exec, calls };
}

function methodOf(call: ExecCall): string | undefined {
  const index = call.args.indexOf('--method');
  return index < 0 ? undefined : call.args[index + 1];
}

test('the action label is user facing', () => {
  assert.equal(ACTION_LABEL, 'Focus terminal');
});

test('detects KDE sessions from the desktop and the full-session flag', () => {
  assert.equal(isKdeSession({ XDG_CURRENT_DESKTOP: 'KDE' }), true);
  assert.equal(isKdeSession({ XDG_CURRENT_DESKTOP: 'ubuntu:KDE' }), true);
  assert.equal(isKdeSession({ KDE_FULL_SESSION: 'true' }), true);
  assert.equal(isKdeSession({ XDG_CURRENT_DESKTOP: 'GNOME' }), false);
  assert.equal(isKdeSession({}), false);
});

test('walks the process ancestry and stops at init or a cycle', () => {
  const parents = new Map([
    [10, 5],
    [5, 2],
    [2, 1],
  ]);
  assert.deepEqual(
    ancestorPids(10, (pid) => parents.get(pid)),
    [10, 5, 2],
  );

  const cycle = new Map([
    [3, 4],
    [4, 3],
  ]);
  assert.deepEqual(
    ancestorPids(3, (pid) => cycle.get(pid)),
    [3, 4],
  );
});

test('resolves the TUI, tmux client and kitty ancestors', async () => {
  const parents = new Map([
    [100, 90],
    [90, 80],
    [15551, 15540],
    [15540, 1195],
    [1195, 1],
  ]);
  const { exec } = recordingExec(() => ({ error: null, stdout: '15551\n' }));

  const pids = await resolveTerminalPids({
    pid: 100,
    env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%0', KITTY_PID: '15540' } as Environment,
    exec,
    parentPid: (pid) => parents.get(pid),
  });

  assert.deepEqual(pids, [100, 90, 80, 15540, 1195, 15551]);
});

test('falls back to tmux list-clients when display-message has no client', async () => {
  const parents = new Map([[900, 800]]);
  const { exec } = recordingExec((call) => {
    if (call.args[0] === 'display-message') return { error: null, stdout: '\n' };
    if (call.args[0] === 'list-clients') return { error: null, stdout: '700\n900\n' };
    return { error: null, stdout: '' };
  });

  const pids = await resolveTerminalPids({
    pid: 500,
    env: { TMUX: '/tmp/tmux-1000/default,1,0' } as Environment,
    exec,
    parentPid: (pid) => parents.get(pid),
  });

  assert.deepEqual(pids, [500, 700, 900, 800]);
});

test('builds a KWin script that switches activity, desktop and focus', () => {
  const script = buildKwinScript([1234, 5678]);
  assert.match(script, /var pids = \[1234, 5678\];/);
  assert.match(script, /workspace\.currentActivity = activities\[0\]/);
  assert.match(script, /workspace\.setCurrentDesktopForScreen\(desktop, target\.output\)/);
  assert.match(script, /workspace\.raiseWindow\(target\)/);
  assert.match(script, /workspace\.activeWindow = target/);
  assert.match(script, /target\.minimized = false/);
  assert.match(script, /w\.pid === pids\[p\]/);
});

test('parses the script id from gdbus output', () => {
  assert.equal(parseScriptId('(7,)\n'), 7);
  assert.equal(parseScriptId('(int32 7,)\n'), 7);
  assert.equal(parseScriptId('(int32 0,)'), 0);
  assert.equal(parseScriptId('(int32 -1,)'), undefined);
  assert.equal(parseScriptId('garbage'), undefined);
});

test('focuses the terminal through KWin and cleans up the script', async () => {
  const { fs, files, removed, directories } = memoryFs();
  const { exec, calls } = recordingExec((call) =>
    methodOf(call)?.endsWith('loadScript')
      ? { error: null, stdout: '(int32 7,)\n' }
      : { error: null },
  );
  const parents = new Map([[100, 90]]);

  const focuser = createFocuser({
    exec,
    fs,
    env: { KDE_FULL_SESSION: 'true', XDG_RUNTIME_DIR: '/run/user/1000' },
    pid: 100,
    parentPid: (pid) => parents.get(pid),
    tmpdir: '/tmp',
    log: () => {},
  });
  focuser.focus();
  await settle();

  assert.deepEqual(directories, ['/run/user/1000/opencode-kde-notify']);
  assert.equal(files.has('/run/user/1000/opencode-kde-notify/focus-100-1.js'), false);
  assert.deepEqual(removed, ['/run/user/1000/opencode-kde-notify/focus-100-1.js']);
  assert.deepEqual(
    calls.map((call) => methodOf(call)).filter((method) => method !== undefined),
    [
      'org.kde.kwin.Scripting.loadScript',
      'org.kde.kwin.Script.run',
      'org.kde.kwin.Script.stop',
      'org.kde.kwin.Scripting.unloadScript',
    ],
  );

  const load = calls.find((call) => methodOf(call)?.endsWith('loadScript'));
  assert.ok(load);
  assert.equal(load.args.at(-2), '/run/user/1000/opencode-kde-notify/focus-100-1.js');
  assert.match(load.args.at(-1) ?? '', /opencode-kde-notify-100-1/);

  const run = calls.find((call) => methodOf(call) === 'org.kde.kwin.Script.run');
  assert.ok(run?.args.includes('/Scripting/Script7'));
});

test('runs the tmux selection and the focus command in order', async () => {
  const { fs } = memoryFs();
  const { exec, calls } = recordingExec((call) => {
    if (call.command === 'gdbus' && methodOf(call)?.endsWith('loadScript')) {
      return { error: null, stdout: '(int32 3,)\n' };
    }
    return { error: null };
  });

  const focuser = createFocuser({
    exec,
    fs,
    env: {
      KDE_FULL_SESSION: 'true',
      XDG_RUNTIME_DIR: '/run/user/1000',
      TMUX: '/tmp/tmux-1000/default,1,0',
      TMUX_PANE: '%2',
    },
    pid: 100,
    parentPid: () => undefined,
    tmpdir: '/tmp',
    log: () => {},
    command: 'kitty @ focus-window',
  });
  focuser.focus();
  await settle();

  const tmux = calls
    .filter((call) => call.command === 'tmux')
    .map((call) => call.args[0])
    .filter((command) => command === 'select-window' || command === 'select-pane');
  assert.deepEqual(tmux, ['select-window', 'select-pane']);
  assert.deepEqual(calls.at(-1), { command: 'sh', args: ['-c', 'kitty @ focus-window'] });
  assert.ok(calls.some((call) => call.command === 'gdbus'));
});

test('outside KDE it skips KWin but still runs the command', async () => {
  const { fs } = memoryFs();
  const { exec, calls } = recordingExec();

  const focuser = createFocuser({
    exec,
    fs,
    env: { XDG_CURRENT_DESKTOP: 'GNOME', XDG_RUNTIME_DIR: '/run/user/1000' },
    pid: 100,
    parentPid: () => undefined,
    tmpdir: '/tmp',
    log: () => {},
    command: 'wmctrl -a OpenCode',
  });
  focuser.focus();
  await settle();

  assert.deepEqual(calls, [{ command: 'sh', args: ['-c', 'wmctrl -a OpenCode'] }]);
});

test('reports a failed KWin script load and still removes the file', async () => {
  const { fs, removed } = memoryFs();
  const logs: string[] = [];
  const missing = Object.assign(new Error('spawn gdbus ENOENT'), { code: 'ENOENT' });
  const { exec, calls } = recordingExec(() => ({ error: missing }));

  const focuser = createFocuser({
    exec,
    fs,
    env: { KDE_FULL_SESSION: 'true', XDG_RUNTIME_DIR: '/run/user/1000' },
    pid: 100,
    parentPid: () => undefined,
    tmpdir: '/tmp',
    log: (message) => logs.push(message),
  });
  focuser.focus();
  await settle();

  assert.deepEqual(
    calls.map((call) => call.command),
    ['gdbus'],
  );
  assert.deepEqual(removed, ['/run/user/1000/opencode-kde-notify/focus-100-1.js']);
  assert.match(logs.join('\n'), /gdbus not found/);
});

test('dispose stops pending focus runs', async () => {
  const { fs } = memoryFs();
  const { exec, calls } = recordingExec();

  const focuser = createFocuser({
    exec,
    fs,
    env: { KDE_FULL_SESSION: 'true', XDG_RUNTIME_DIR: '/run/user/1000' },
    pid: 100,
    parentPid: () => undefined,
    tmpdir: '/tmp',
    log: () => {},
  });
  focuser.dispose();
  focuser.focus();
  await settle();

  assert.deepEqual(calls, []);
});
