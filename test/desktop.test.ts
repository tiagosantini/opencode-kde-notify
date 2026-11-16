import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DESKTOP_ENTRY,
  DESKTOP_FILE,
  MARKER,
  desktopFileContent,
  desktopLocations,
  ensureDesktopEntry,
  type FileSystem,
} from '../src/desktop.ts';

function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const directories: string[] = [];
  const fs: FileSystem = {
    readFile: (path) => files.get(path),
    writeFile: (path, content) => {
      files.set(path, content);
    },
    makeDirectory: (path) => {
      directories.push(path);
    },
  };
  return { fs, files, directories };
}

test('the desktop entry carries the identity Plasma resolves', () => {
  const content = desktopFileContent();
  assert.match(content, /^\[Desktop Entry\]$/m);
  assert.match(content, /^Type=Application$/m);
  assert.match(content, /^Name=OpenCode$/m);
  assert.match(content, /^NoDisplay=true$/m);
  assert.ok(content.includes(MARKER));
  assert.ok(content.endsWith('\n'));
  assert.equal(DESKTOP_FILE, `${DESKTOP_ENTRY}.desktop`);
});

test('honours XDG_DATA_HOME and falls back to ~/.local/share', () => {
  assert.deepEqual(desktopLocations({ XDG_DATA_HOME: '/data' }), {
    directory: '/data/applications',
    file: `/data/applications/${DESKTOP_FILE}`,
  });
  assert.deepEqual(desktopLocations({ XDG_DATA_HOME: '/data/' }), {
    directory: '/data/applications',
    file: `/data/applications/${DESKTOP_FILE}`,
  });
  assert.deepEqual(desktopLocations({ HOME: '/home/user' }), {
    directory: '/home/user/.local/share/applications',
    file: `/home/user/.local/share/applications/${DESKTOP_FILE}`,
  });
  assert.equal(desktopLocations({}), undefined);
});

test('creates the file and its directory when missing', () => {
  const { fs, files, directories } = memoryFs();
  ensureDesktopEntry(fs, { HOME: '/home/user' });

  const path = `/home/user/.local/share/applications/${DESKTOP_FILE}`;
  assert.deepEqual(directories, ['/home/user/.local/share/applications']);
  assert.equal(files.get(path), desktopFileContent());
});

test('rewrites stale content that this plugin created', () => {
  const path = `/home/user/.local/share/applications/${DESKTOP_FILE}`;
  const { fs, files } = memoryFs({ [path]: `[Desktop Entry]\n${MARKER}\n` });

  ensureDesktopEntry(fs, { HOME: '/home/user' });

  assert.equal(files.get(path), desktopFileContent());
});

test('leaves a desktop entry alone when it is identical', () => {
  const path = `/home/user/.local/share/applications/${DESKTOP_FILE}`;
  const { fs, files } = memoryFs({ [path]: desktopFileContent() });
  const writes: string[] = [];
  const counting: FileSystem = {
    readFile: fs.readFile,
    writeFile: (target, content) => {
      writes.push(target);
      fs.writeFile(target, content);
    },
    makeDirectory: fs.makeDirectory,
  };

  ensureDesktopEntry(counting, { HOME: '/home/user' });

  assert.deepEqual(writes, []);
  assert.equal(files.get(path), desktopFileContent());
});

test('never touches a desktop entry it did not create', () => {
  const path = `/home/user/.local/share/applications/${DESKTOP_FILE}`;
  const foreign = '[Desktop Entry]\nType=Application\nName=OpenCode CLI\n';
  const { fs, files } = memoryFs({ [path]: foreign });

  ensureDesktopEntry(fs, { HOME: '/home/user' });

  assert.equal(files.get(path), foreign);
});

test('reports write failures without throwing', () => {
  const logs: string[] = [];
  const fs: FileSystem = {
    readFile: () => undefined,
    writeFile: () => {
      throw new Error('EROFS: read-only file system');
    },
    makeDirectory: () => {},
  };

  assert.doesNotThrow(() =>
    ensureDesktopEntry(fs, { HOME: '/home/user' }, (message) => logs.push(message)),
  );
  assert.deepEqual(logs, ['[kde-notify] could not write the desktop entry']);
});

test('skips without HOME or XDG_DATA_HOME', () => {
  const logs: string[] = [];
  const { fs, files } = memoryFs();

  ensureDesktopEntry(fs, {}, (message) => logs.push(message));

  assert.equal(files.size, 0);
  assert.deepEqual(logs, ['[kde-notify] HOME is not set; desktop entry skipped']);
});
