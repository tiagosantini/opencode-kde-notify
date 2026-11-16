import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { Plugin } from '@opencode/plugin/tui';

import type { FileSystem } from './desktop.ts';
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
};

export default Plugin.define({
  id: 'kde.notify',
  setup(ctx) {
    return start(ctx, { exec: execFile, fs: fileSystem });
  },
});
