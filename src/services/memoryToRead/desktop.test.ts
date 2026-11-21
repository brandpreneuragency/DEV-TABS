// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMemoryToRead } from './desktop';
import { MEMORY_TO_READ_DIRECTORY as ROOT } from './reader';
import type { DirEntry } from '../memoryResources/reader';

const native = vi.hoisted(() => ({ isTauriRuntime: vi.fn(), readDir: vi.fn(), stat: vi.fn(), readTextFile: vi.fn() }));
vi.mock('../runtime', () => ({ isTauriRuntime: native.isTauriRuntime }));
vi.mock('@tauri-apps/plugin-fs', () => ({ BaseDirectory: { Home: 21 }, readDir: native.readDir, stat: native.stat, readTextFile: native.readTextFile }));
const file = (name: string): DirEntry => ({ name, isFile: true, isDirectory: false, isSymlink: false });
const dir = (name: string): DirEntry => ({ name, isFile: false, isDirectory: true, isSymlink: false });
let tree: Record<string, DirEntry[]>;
beforeEach(() => {
  vi.resetAllMocks();
  tree = { '': [dir('MOTHER')], MOTHER: [dir('MEMORY')], 'MOTHER/MEMORY': [dir('To-Read'), dir('Resources')],
    [ROOT]: [file('reading.md'), dir('Bundle')], [`${ROOT}/Bundle`]: [file('reading.md'), dir('assets')] };
  native.isTauriRuntime.mockReturnValue(true);
  native.readDir.mockImplementation(async (path: string) => { if (!tree[path]) throw Error('private backend error'); return tree[path]; });
  native.stat.mockResolvedValue({ isFile: true, isDirectory: false, isSymlink: false, size: 10 });
  native.readTextFile.mockResolvedValue('# Reading\n\nSummary.');
});

describe('To-Read native boundary (synthetic plugin)', () => {
  it('uses the fixed Home/To-Read root and no Resources, category or asset reads', async () => {
    expect((await loadMemoryToRead()).notes.map((note) => note.fileName)).toEqual(['reading.md', 'Bundle/reading.md']);
    expect(native.readTextFile.mock.calls).toEqual([[`${ROOT}/reading.md`, { baseDir: 21 }], [`${ROOT}/Bundle/reading.md`, { baseDir: 21 }]]);
    expect(native.readDir).not.toHaveBeenCalledWith('MOTHER/MEMORY/Resources', expect.anything());
    expect(native.readDir).not.toHaveBeenCalledWith(`${ROOT}/Bundle/assets`, expect.anything());
  });
  it('does not probe native files in browser preview', async () => {
    native.isTauriRuntime.mockReturnValue(false);
    await expect(loadMemoryToRead()).rejects.toMatchObject({ code: 'unsupported' });
    expect(native.readDir).not.toHaveBeenCalled();
  });
  it('distinguishes missing root from read failure', async () => {
    tree['MOTHER/MEMORY'] = [];
    await expect(loadMemoryToRead()).rejects.toMatchObject({ code: 'missing' });
    native.readDir.mockRejectedValue(Error('private backend error'));
    await expect(loadMemoryToRead()).rejects.toMatchObject({ code: 'read', message: 'Memory Notes: read' });
  });
  it('rejects a linked fixed ancestor without opening records', async () => {
    tree.MOTHER[0].isSymlink = true;
    await expect(loadMemoryToRead()).rejects.toMatchObject({ code: 'read' });
    expect(native.readTextFile).not.toHaveBeenCalled();
  });
  it('rejects a newly linked file between stat and read', async () => {
    native.stat.mockImplementation(async () => { tree[ROOT][0].isSymlink = true; return { isFile: true, isDirectory: false, isSymlink: false, size: 10 }; });
    const result = await loadMemoryToRead();
    expect(result.issues).toContainEqual({ fileName: 'reading.md', reason: 'read' });
    expect(native.readTextFile).not.toHaveBeenCalledWith(`${ROOT}/reading.md`, expect.anything());
  });
  it('applies the size limit before and after UTF-8 reads', async () => {
    tree[ROOT] = [file('reading.md')];
    native.stat.mockResolvedValue({ isFile: true, isDirectory: false, isSymlink: false, size: 1_048_577 });
    expect((await loadMemoryToRead()).issues).toEqual([{ fileName: 'reading.md', reason: 'tooLarge' }]);
    expect(native.readTextFile).not.toHaveBeenCalled();
    native.stat.mockResolvedValue({ isFile: true, isDirectory: false, isSymlink: false, size: 10 });
    native.readTextFile.mockResolvedValue('ü'.repeat(524_289));
    expect((await loadMemoryToRead()).issues).toEqual([{ fileName: 'reading.md', reason: 'tooLarge' }]);
  });
});
