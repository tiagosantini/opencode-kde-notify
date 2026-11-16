import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SETTINGS, readSettings, shouldActivate } from '../src/config.ts';

test('uses the defaults when there are no options and no environment', () => {
  assert.deepEqual(readSettings(undefined, {}), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings({}, {}), DEFAULT_SETTINGS);
});

test('reads mode and when from the plugin options', () => {
  assert.deepEqual(readSettings({ mode: 'always', when: 'always' }, {}), {
    mode: 'always',
    when: 'always',
    desktopEntry: true,
    focusOnClick: true,
  });
});

test('options take precedence over environment variables', () => {
  const env = { OPENCODE_KDE_NOTIFY_MODE: 'always', OPENCODE_KDE_NOTIFY_WHEN: 'always' };
  assert.deepEqual(readSettings({ mode: 'auto', when: 'blurred' }, env), {
    mode: 'auto',
    when: 'blurred',
    desktopEntry: true,
    focusOnClick: true,
  });
});

test('accepts environment variables as an alternative to configuration', () => {
  const env = { OPENCODE_KDE_NOTIFY_MODE: 'always', OPENCODE_KDE_NOTIFY_WHEN: 'always' };
  assert.deepEqual(readSettings(undefined, env), {
    mode: 'always',
    when: 'always',
    desktopEntry: true,
    focusOnClick: true,
  });
});

test('ignores invalid values', () => {
  assert.deepEqual(readSettings({ mode: 'sometimes', when: 'whenever' }, {}), DEFAULT_SETTINGS);
  assert.deepEqual(
    readSettings(undefined, { OPENCODE_KDE_NOTIFY_MODE: 'never', OPENCODE_KDE_NOTIFY_WHEN: 'x' }),
    DEFAULT_SETTINGS,
  );
});

test('reads the desktopEntry switch from options and environment', () => {
  assert.equal(readSettings({ desktopEntry: false }, {}).desktopEntry, false);
  assert.equal(readSettings({ desktopEntry: true }, {}).desktopEntry, true);
  assert.equal(
    readSettings(undefined, { OPENCODE_KDE_NOTIFY_DESKTOP_ENTRY: 'false' }).desktopEntry,
    false,
  );
  assert.equal(
    readSettings(undefined, { OPENCODE_KDE_NOTIFY_DESKTOP_ENTRY: 'true' }).desktopEntry,
    true,
  );
});

test('keeps desktopEntry on for unusable values', () => {
  assert.equal(readSettings({ desktopEntry: 'nope' }, {}).desktopEntry, true);
  assert.equal(
    readSettings(undefined, { OPENCODE_KDE_NOTIFY_DESKTOP_ENTRY: 'never' }).desktopEntry,
    true,
  );
});

test('reads the focusOnClick switch from options and environment', () => {
  assert.equal(readSettings({ focusOnClick: false }, {}).focusOnClick, false);
  assert.equal(readSettings({ focusOnClick: true }, {}).focusOnClick, true);
  assert.equal(
    readSettings(undefined, { OPENCODE_KDE_NOTIFY_FOCUS_ON_CLICK: 'false' }).focusOnClick,
    false,
  );
  assert.equal(
    readSettings(undefined, { OPENCODE_KDE_NOTIFY_FOCUS_ON_CLICK: 'true' }).focusOnClick,
    true,
  );
  assert.equal(
    readSettings({ focusOnClick: true }, { OPENCODE_KDE_NOTIFY_FOCUS_ON_CLICK: 'false' })
      .focusOnClick,
    true,
  );
  assert.equal(readSettings({ focusOnClick: 'nope' }, {}).focusOnClick, true);
});

test('reads focusCommand and drops blank values', () => {
  assert.equal(
    readSettings({ focusCommand: 'kitty @ focus-window' }, {}).focusCommand,
    'kitty @ focus-window',
  );
  assert.equal(
    readSettings(undefined, { OPENCODE_KDE_NOTIFY_FOCUS_COMMAND: 'xdotool getactivewindow' })
      .focusCommand,
    'xdotool getactivewindow',
  );
  assert.equal(readSettings({ focusCommand: '   ' }, {}).focusCommand, undefined);
  assert.equal(readSettings({ focusCommand: 42 }, {}).focusCommand, undefined);
  assert.equal(
    readSettings({ focusCommand: 'option' }, { OPENCODE_KDE_NOTIFY_FOCUS_COMMAND: 'env' })
      .focusCommand,
    'option',
  );
});

test('activates outside kitty or inside tmux', () => {
  const auto = DEFAULT_SETTINGS;
  assert.equal(shouldActivate(auto, {}), true);
  assert.equal(shouldActivate(auto, { TMUX: '/tmp/tmux-1000/default,1,0' }), true);
  assert.equal(
    shouldActivate(auto, { KITTY_WINDOW_ID: '1', TMUX: '/tmp/tmux-1000/default,1,0' }),
    true,
  );
  assert.equal(shouldActivate(auto, { KITTY_WINDOW_ID: '1' }), false);
});

test('mode always ignores terminal detection', () => {
  assert.equal(
    shouldActivate({ ...DEFAULT_SETTINGS, mode: 'always' }, { KITTY_WINDOW_ID: '1' }),
    true,
  );
});
