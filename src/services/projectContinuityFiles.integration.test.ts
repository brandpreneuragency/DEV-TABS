import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TauriFolderConnector } from './tauri-folder-connector';
import { readContinuityFile } from './projectContinuityFiles';

const selected = vi.hoisted(() => ({ path: '' }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: async () => selected.path }));
// Only the native plugin boundary is replaced; service, FS adapter and desktop connector are real.
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppLocalData: 1 },
  readTextFile: async (path: string) => readFile(path, 'utf8'),
  stat: async (path: string) => {
    const value = await stat(path);
    return { size: value.size, mtime: value.mtime, isFile: value.isFile(), isDirectory: value.isDirectory() };
  },
}));
vi.mock('./runtime', () => ({ isTauriRuntime: () => true, getFolderConnector: async () => new TauriFolderConnector() }));

it('reads and refreshes a selected disposable file through the real desktop adapter without modifying it', async () => {
  if (!process.env.TMPDIR) throw new Error('TMPDIR must name the agent scratch directory');
  const directory = await mkdtemp(join(process.env.TMPDIR, 'tabs-continuity-'));
  const file = join(directory, 'work-record.md');
  selected.path = file;
  const normalized = file.replace(/\\/g, '/');
  try {
    const content = '# Fixture handoff\nNext: owner trial\n';
    await writeFile(file, content, 'utf8');
    expect((await readContinuityFile(normalized))?.text).toBe(content);
    expect(await readFile(file, 'utf8')).toBe(content);
    await writeFile(file, '# Updated fixture\n', 'utf8');
    expect((await readContinuityFile(normalized))?.text).toBe('# Updated fixture\n');
    await rm(file);
    await expect(readContinuityFile(normalized)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
