// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMemorySomeday } from './desktop';
import { MEMORY_SOMEDAY_DIRECTORY as ROOT } from './reader';
import type { DirEntry } from '../memoryResources/reader';

const native = vi.hoisted(() => ({ runtime: vi.fn(), readDir: vi.fn(), stat: vi.fn(), readTextFile: vi.fn() }));
vi.mock('../runtime', () => ({ isTauriRuntime: native.runtime }));
vi.mock('@tauri-apps/plugin-fs', () => ({ BaseDirectory: { Home: 21 }, readDir: native.readDir, stat: native.stat, readTextFile: native.readTextFile }));
const file = (name: string): DirEntry => ({ name, isFile: true, isDirectory: false, isSymlink: false });
const dir = (name: string): DirEntry => ({ name, isFile: false, isDirectory: true, isSymlink: false });
let tree: Record<string, DirEntry[]>;
beforeEach(() => {
  vi.resetAllMocks();
  tree = { '': [dir('MOTHER')], MOTHER: [dir('MEMORY')], 'MOTHER/MEMORY': [dir('Someday'), dir('Notes')],
    [ROOT]: [file('stray.md'), dir('Idea')], [`${ROOT}/Idea`]: [file('idea.md'), dir('assets')] };
  native.runtime.mockReturnValue(true);
  native.readDir.mockImplementation(async (path: string) => { if (!tree[path]) throw Error('private'); return tree[path]; });
  native.stat.mockResolvedValue({ isFile: true, isDirectory: false, isSymlink: false, size: 10 });
  native.readTextFile.mockResolvedValue('# Idea\n\nSummary.');
});
describe('Someday native boundary with synthetic plugin', () => {
  it('reads only the fixed Someday idea path', async () => {
    expect((await loadMemorySomeday()).notes.map((note) => note.fileName)).toEqual(['Idea/idea.md']);
    expect(native.readTextFile.mock.calls).toEqual([[`${ROOT}/Idea/idea.md`, { baseDir: 21 }]]);
    expect(native.readDir).not.toHaveBeenCalledWith(`${ROOT}/Idea/assets`, expect.anything());
    expect(native.readDir).not.toHaveBeenCalledWith('MOTHER/MEMORY/Notes', expect.anything());
  });
  it('does not access native filesystem from browser preview', async () => {
    native.runtime.mockReturnValue(false);
    await expect(loadMemorySomeday()).rejects.toMatchObject({ code: 'unsupported' });
    expect(native.readDir).not.toHaveBeenCalled();
  });
  it('distinguishes missing root from unsafe ancestor and read failures', async () => {
    tree['MOTHER/MEMORY'] = [];
    await expect(loadMemorySomeday()).rejects.toMatchObject({ code: 'missing' });
    tree['MOTHER/MEMORY'] = [{ ...dir('Someday'), isSymlink: true }];
    await expect(loadMemorySomeday()).rejects.toMatchObject({ code: 'read' });
    native.readDir.mockRejectedValue(Error('private'));
    await expect(loadMemorySomeday()).rejects.toMatchObject({ code: 'read' });
    expect(native.readTextFile).not.toHaveBeenCalled();
  });
  it('enforces size and rechecks links after stat', async () => {
    native.stat.mockResolvedValueOnce({ isFile: true, isDirectory: false, isSymlink: false, size: 1_048_577 });
    expect((await loadMemorySomeday()).issues).toContainEqual({ fileName: 'Idea/idea.md', reason: 'tooLarge' });
    native.stat.mockImplementationOnce(async () => { tree[`${ROOT}/Idea`][0].isSymlink = true; return { isFile: true, isDirectory: false, isSymlink: false, size: 10 }; });
    expect((await loadMemorySomeday()).issues).toContainEqual({ fileName: 'Idea/idea.md', reason: 'read' });
    expect(native.readTextFile).not.toHaveBeenCalled();
  });
});
