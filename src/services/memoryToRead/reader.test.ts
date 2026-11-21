// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readMemoryToRead } from './reader';
import type { DirEntry } from '../memoryResources/reader';
const file = (name: string): DirEntry => ({ name, isFile: true, isDirectory: false, isSymlink: false });
const dir = (name: string): DirEntry => ({ name, isFile: false, isDirectory: true, isSymlink: false });

describe('To-Read folder boundary', () => {
  it('reads direct records and one-record bundles, not categories or asset trees', async () => {
    const tree: Record<string, DirEntry[]> = { '': [file('same.md'), file('AGENTS.md'), file('README.md'), dir('Bundle'), dir('References')],
      Bundle: [file('same.md'), file('scan.pdf'), dir('assets')], References: [] };
    const source = { list: vi.fn(async (path: string) => tree[path]), read: vi.fn(async () => '# Reading\n\nSummary.') };
    const result = await readMemoryToRead(source);
    expect(result.notes.map((note) => note.fileName)).toEqual(['same.md', 'Bundle/same.md']);
    expect(result.notes.every((note) => !('category' in note))).toBe(true);
    expect(result.issues).toEqual([]);
    expect(source.list.mock.calls.map(([path]) => path)).toEqual(['', 'Bundle', 'References']);
  });
  it('reports ambiguous/deeper bundles, traversal, conflicts and links without following them', async () => {
    const list = vi.fn(async (path: string) => path === 'Ambiguous' ? [file('a.md'), file('b.md')]
      : path === 'Deep' ? [dir('nested'), file('a.md')] : [dir('Ambiguous'), dir('Deep'), dir('../Personal'), dir('VAULT'),
        { ...dir('linked'), isSymlink: true }, file('a.sync-conflict-copy.md'), file('.hidden.md')]);
    const read = vi.fn();
    const result = await readMemoryToRead({ list, read });
    expect(result.issues.filter((issue) => issue.reason === 'bundle')).toHaveLength(2);
    expect(result.issues.some((issue) => issue.reason === 'conflict')).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(list.mock.calls.map(([path]) => path)).toEqual(['', 'Ambiguous', 'Deep']);
  });
  it('keeps good records when a read fails and rejects a root-list failure', async () => {
    const source = { list: async () => [file('good.md'), file('bad.md')],
      read: async (path: string) => { if (path === 'bad.md') throw Error('private error'); return '# Good'; } };
    const result = await readMemoryToRead(source);
    expect(result.notes.map((note) => note.title)).toEqual(['Good']);
    expect(result.issues).toEqual([{ fileName: 'bad.md', reason: 'read' }]);
    await expect(readMemoryToRead({ list: async () => { throw Error('missing'); }, read: vi.fn() })).rejects.toThrow();
  });
});
