// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readMemoryResources, type DirEntry } from './reader';
const file = (name: string): DirEntry => ({ name, isFile: true, isDirectory: false, isSymlink: false });
const dir = (name: string): DirEntry => ({ name, isFile: false, isDirectory: true, isSymlink: false });

describe('bounded resource reading', () => {
  it('reads real root, category and single-main bundle fixtures, preserving duplicate basenames', async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'resources-'));
    try {
      await mkdir(join(root, 'Tools', 'Bundle', 'assets'), { recursive: true });
      for (const name of ['same.md', 'Tools/same.md', 'Tools/Bundle/main.md', 'Tools/Bundle/README.md', 'Tools/Bundle/assets/ignored.md', 'AGENTS.md']) await writeFile(join(root, name), '# Fixture\n\nSummary.');
      const list = vi.fn(async (path: string) => (await readdir(join(root, path), { withFileTypes: true })).map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), isSymlink: entry.isSymbolicLink() })));
      const result = await readMemoryResources({ list, read: (path) => readFile(join(root, path), 'utf8') });
      expect(result.notes.map((note) => note.fileName).sort()).toEqual(['Tools/Bundle/main.md', 'Tools/same.md', 'same.md']);
      expect(result.issues).toEqual([]);
      expect(list.mock.calls.map(([path]) => path).sort()).toEqual(['', 'Tools', 'Tools/Bundle']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects traversal, links and conflict directories without descending', async () => {
    const list = vi.fn(async () => [dir('../escape'), dir('bad:name'), dir('trailing.'), dir('trailing '), dir('.hidden'), dir('VAULT'), { ...dir('linked'), isSymlink: true }, dir('Tools.sync-conflict-copy'), file('a.sync-conflict-copy.md')]);
    const read = vi.fn();
    const result = await readMemoryResources({ list, read });
    expect(result.notes).toEqual([]);
    expect(result.issues.filter((issue) => issue.reason === 'conflict')).toHaveLength(2);
    expect(list).toHaveBeenCalledExactlyOnceWith('');
    expect(read).not.toHaveBeenCalled();
  });
  it('reports ambiguous, missing and deeper bundles without guessing', async () => {
    const tree: Record<string, DirEntry[]> = { '': [dir('Tools')], Tools: [dir('many'), dir('empty'), dir('deep')], 'Tools/many': [file('a.md'), file('b.md')], 'Tools/empty': [file('README.md')], 'Tools/deep': [dir('nested')] };
    const read = vi.fn();
    const result = await readMemoryResources({ list: async (path) => tree[path], read });
    expect(result.issues.map((issue) => issue.reason)).toEqual(['bundle', 'bundle', 'bundle']);
    expect(read).not.toHaveBeenCalled();
  });
  it('keeps successful records on child list/read failure but rejects root failure', async () => {
    const result = await readMemoryResources({ list: async (path) => { if (path) throw Error('private error'); return [file('ok.md'), file('bad.md'), dir('broken')]; }, read: async (path) => { if (path === 'bad.md') throw Error('private error'); return '# OK'; } });
    expect(result.notes).toHaveLength(1);
    expect(result.issues).toEqual([{ fileName: 'bad.md', reason: 'read' }, { fileName: 'broken', reason: 'read' }]);
    await expect(readMemoryResources({ list: async () => { throw Error('failure'); }, read: vi.fn() })).rejects.toThrow();
  });
});
