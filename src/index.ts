import { Plugin } from '@opencode/plugin';

/**
 * Minimal server part: the plugin is TUI-only, but declaring it here gives the
 * package its identity and lets OpenCode discover the whole package.
 */
export default Plugin.define({
  id: 'kde.notify',
  setup() {},
});
