import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  APP_NAME,
  MAX_BODY,
  buildArgs,
  compact,
  createSender,
  type Notice,
} from '../src/notify.ts';

const notice: Notice = {
  title: 'Task completed',
  body: 'Fix the dashboard login',
  icon: 'dialog-information',
  urgency: 'normal',
  expire: 8000,
};

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
    'Task completed',
    'Fix the dashboard login',
  ]);
});

test('createSender runs notify-send with the expected arguments', () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const send = createSender((command, args, callback) => {
    calls.push({ command, args });
    callback(null);
  });

  send(notice);

  assert.deepEqual(calls, [{ command: 'notify-send', args: buildArgs(notice) }]);
});

test('createSender logs a missing notify-send without throwing', () => {
  const logs: string[] = [];
  const missing = Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' });
  const send = createSender(
    (_command, _args, callback) => callback(missing),
    (message) => logs.push(message),
  );

  assert.doesNotThrow(() => send(notice));
  assert.deepEqual(logs, ['[kde-notify] notify-send not found; notification skipped']);
});

test('createSender logs generic failures', () => {
  const logs: string[] = [];
  const send = createSender(
    (_command, _args, callback) => callback(new Error('Connection refused')),
    (message) => logs.push(message),
  );

  send(notice);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? '', /notify-send failed: Connection refused/);
});
