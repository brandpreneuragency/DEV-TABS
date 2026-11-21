// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readMemorySomeday } from './reader';
import type { DirEntry } from '../memoryResources/reader';
const file = (name: string): DirEntry => ({ name, isFile: true, isDirectory: false, isSymlink: false });
const dir = (name: string): DirEntry => ({ name, isFile: false, isDirectory: true, isSymlink: false });

describe('Someday idea folder boundary', () => {
  it('reads one record per idea folder and never scans assets or root files', async () => {
    const tree: Record<string, DirEntry[]> = { '': [file('README.md'), file('stray.md'), dir('Idea'), dir('Other')],
      Idea: [file('idea.md'), dir('assets')], Other: [file('idea.md'), file('image.png')] };
    const source = { list: vi.fn(async (path: string) => tree[path]), read: vi.fn(async (path: string) => `# Future idea\n\nA useful idea at ${path}.`) };
    const snapshot = await readMemorySomeday(source);
    expect(snapshot.notes.map((note) => note.fileName)).toEqual(['Idea/idea.md', 'Other/idea.md']);
    expect(snapshot.issues).toEqual([]);
    expect(source.list.mock.calls.map(([path]) => path)).toEqual(['', 'Idea', 'Other']);
    expect(source.read.mock.calls.map(([path]) => path)).toEqual(['Idea/idea.md', 'Other/idea.md']);
  });
  it('reports ambiguous and linked idea folders without opening their files', async () => {
    const list = vi.fn(async (path: string) => path === 'Ambiguous' ? [file('a.md'), file('b.md')]
      : [dir('Ambiguous'), { ...dir('Linked'), isSymlink: true }, dir('../Personal')]);
    const read = vi.fn();
    const snapshot = await readMemorySomeday({ list, read });
    expect(snapshot.notes).toEqual([]);
    expect(snapshot.issues).toContainEqual({ fileName: 'Ambiguous', reason: 'bundle' });
    expect(snapshot.issues).toContainEqual({ fileName: 'Linked', reason: 'unsafe' });
    expect(read).not.toHaveBeenCalled();
  });
});
