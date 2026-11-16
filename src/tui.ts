import { execFile } from 'node:child_process';

import { Plugin } from '@opencode/plugin/tui';

import { start } from './plugin.ts';

export default Plugin.define({
  id: 'kde.notify',
  setup(ctx) {
    return start(ctx, { exec: execFile });
  },
});
