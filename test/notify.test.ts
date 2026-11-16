import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import {
  APP_NAME,
  MAX_BODY,
  buildArgs,
  compact,
  createSender,
  type ChildProcessHandle,
  type Notice,
  type Spawn,
} from '../src/notify.ts';
import { DESKTOP_ENTRY } from '../src/desktop.ts';

const notice: Notice = {
  title: 'Task completed',
  body: 'Fix the dashboard login',
  icon: 'dialog-information',
  urgency: 'normal',
  expire: 8000,
};

const clickable: Notice = { ...notice, action: 'Focus terminal' };

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

  print(text: string): void {
    this.stdout.emit('data', text);
  }

  error(message: string, code?: string): void {
    this.events.emit('error', Object.assign(new Error(message), code ? { code } : {}));
  }

  write(text: string): void {
    this.stderr.emit('data', text);
  }

  close(code: number | null): void {
    this.events.emit('close', code);
  }
}

function fakeSpawn() {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const children: FakeChild[] = [];
  const spawn: Spawn = (command, args) => {
    calls.push({ command, args });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcessHandle;
  };
  return { spawn, calls, children };
}

test('compact normalizes whitespace and falls back when empty', () => {
  assert.equal(compact('  multiple\n\tlines  ', 'x'), 'multiple lines');
  assert.equal(compact('', 'fallback'), 'fallback');
  assert.equal(compact(undefined, 'fallback'), 'fallback');
});

test('compact truncates long texts with an ellipsis', () => {
  const result = compact('a'.repeat(MAX_BODY + 50), 'x');
  assert.equal(result.length, MAX_BODY);
  assert.ok(result.endsWith('…'));
});

test('buildArgs assembles the notify-send command line', () => {
  assert.deepEqual(buildArgs(notice), [
    `--app-name=${APP_NAME}`,
    '--icon=dialog-information',
    '--urgency=normal',
    '--expire-time=8000',
    '--hint=string:desktop-entry:opencode',
    'Task completed',
    'Fix the dashboard login',
  ]);
});

test('buildArgs adds a default action only for clickable notices', () => {
  const args = buildArgs(clickable);
  assert.ok(args.includes('--action=default=Focus terminal'));
  assert.deepEqual(args.slice(-2), ['Task completed', 'Fix the dashboard login']);
  assert.ok(!buildArgs(notice).some((arg) => arg.startsWith('--action=')));
});

test('buildArgs points the desktop-entry hint at the packaged identity', () => {
  const hint = buildArgs(notice).find((arg) => arg.startsWith('--hint='));
  assert.equal(hint, `--hint=string:desktop-entry:${DESKTOP_ENTRY}`);
});

test('createSender spawns notify-send with the expected arguments', () => {
  const fake = fakeSpawn();
  createSender(fake.spawn).send(clickable);

  assert.deepEqual(fake.calls, [{ command: 'notify-send', args: buildArgs(clickable) }]);
});

test('createSender reports a click and only does so once', () => {
  const fake = fakeSpawn();
  let clicks = 0;
  createSender(fake.spawn).send(clickable, () => {
    clicks += 1;
  });

  fake.children[0]?.print('default\n');
  fake.children[0]?.print('default\n');
  assert.equal(clicks, 1);
});

test('createSender handles an action split across chunks', () => {
  const fake = fakeSpawn();
  let clicks = 0;
  createSender(fake.spawn).send(clickable, () => {
    clicks += 1;
  });

  fake.children[0]?.print('def');
  fake.children[0]?.print('ault\n');
  assert.equal(clicks, 1);
});

test('createSender ignores actions that are not the default one', () => {
  const fake = fakeSpawn();
  let clicks = 0;
  createSender(fake.spawn).send(clickable, () => {
    clicks += 1;
  });

  fake.children[0]?.print('inline-reply\n');
  assert.equal(clicks, 0);
});

test('createSender logs a missing notify-send without throwing', () => {
  const logs: string[] = [];
  const fake = fakeSpawn();
  const sender = createSender(fake.spawn, (message) => logs.push(message));

  assert.doesNotThrow(() => sender.send(clickable));
  fake.children[0]?.error('spawn notify-send ENOENT', 'ENOENT');
  assert.deepEqual(logs, ['[kde-notify] notify-send not found; notification skipped']);
});

test('createSender logs generic failures', () => {
  const logs: string[] = [];
  const fake = fakeSpawn();
  const sender = createSender(fake.spawn, (message) => logs.push(message));

  sender.send(clickable);
  fake.children[0]?.error('Connection refused');
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? '', /notify-send failed: Connection refused/);
});

test('createSender retries without the action when notify-send is too old', () => {
  const logs: string[] = [];
  const fake = fakeSpawn();
  const sender = createSender(fake.spawn, (message) => logs.push(message));

  sender.send(clickable);
  fake.children[0]?.write("notify-send: unrecognized option '--action=default=Focus terminal'\n");
  fake.children[0]?.close(1);

  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[1]?.args, buildArgs({ ...clickable, action: undefined }));
  assert.match(logs.join('\n'), /without action support/);

  sender.send(clickable);
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.calls[2]?.args, buildArgs({ ...clickable, action: undefined }));
});

test('createSender tolerates servers without action support', () => {
  const logs: string[] = [];
  const fake = fakeSpawn();
  const sender = createSender(fake.spawn, (message) => logs.push(message));

  sender.send(clickable);
  fake.children[0]?.write('Actions are not supported by this notifications server.\n');
  fake.children[0]?.close(1);

  assert.equal(fake.calls.length, 1);
  assert.deepEqual(logs, []);
});

test('dispose stops waiting for clicks', () => {
  const fake = fakeSpawn();
  const sender = createSender(fake.spawn);
  let clicks = 0;
  sender.send(clickable, () => {
    clicks += 1;
  });

  sender.dispose();
  fake.children[0]?.print('default\n');
  sender.send(clickable);

  assert.equal(clicks, 0);
  assert.equal(fake.children[0]?.killed, true);
  assert.equal(fake.calls.length, 1);
});
