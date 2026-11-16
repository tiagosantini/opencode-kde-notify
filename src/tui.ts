import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { Plugin } from '@opencode/plugin/tui';

import type { FileSystem } from './desktop.ts';
import { createFocuser } from './focus.ts';
import type { ChildProcessHandle, ExecFile, Spawn } from './notify.ts';
import { start } from './plugin.ts';

const fileSystem: FileSystem = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  writeFile(path, content) {
    writeFileSync(path, content, 'utf8');
  },
  makeDirectory(path) {
    mkdirSync(path, { recursive: true });
  },
  removeFile(path) {
    rmSync(path, { force: true });
  },
};

const exec: ExecFile = (command, args, callback) => {
  execFile(command, args, { timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) =>
    callback(error, stdout, stderr),
  );
};

const spawnChild: Spawn = (command, args) =>
  spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessHandle;

/** Reads the parent pid from `/proc/<pid>/stat`; `comm` may contain spaces. */
function readParentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return undefined;
    const parent = Number(stat.slice(end + 2).split(' ')[1]);
    return Number.isInteger(parent) && parent > 0 ? parent : undefined;
  } catch {
    return undefined;
  }
}

export default Plugin.define({
  id: 'kde.notify',
  setup(ctx) {
    return start(ctx, {
      exec,
      spawn: spawnChild,
      fs: fileSystem,
      createFocus: ({ env, command, log }) =>
        createFocuser({
          exec,
          fs: fileSystem,
          env,
          pid: process.pid,
          parentPid: readParentPid,
          tmpdir: tmpdir(),
          log,
          command,
        }),
    });
  },
});
