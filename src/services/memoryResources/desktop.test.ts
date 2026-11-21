// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMemoryResources } from './desktop';
import { MEMORY_RESOURCES_DIRECTORY as ROOT, type DirEntry } from './reader';
const native = vi.hoisted(() => ({ isTauriRuntime: vi.fn(), readDir: vi.fn(), stat: vi.fn(), readTextFile: vi.fn() }));
vi.mock('../runtime', () => ({ isTauriRuntime: native.isTauriRuntime }));
vi.mock('@tauri-apps/plugin-fs', () => ({ BaseDirectory: { Home: 21 }, readDir: native.readDir, stat: native.stat, readTextFile: native.readTextFile }));
const file = (name: string): DirEntry => ({ name, isFile: true, isDirectory: false, isSymlink: false });
const dir = (name: string): DirEntry => ({ name, isFile: false, isDirectory: true, isSymlink: false });
let tree: Record<string, DirEntry[]>;
beforeEach(() => {
  vi.resetAllMocks();
  tree = { '': [dir('MOTHER')], MOTHER: [dir('MEMORY')], 'MOTHER/MEMORY': [dir('Resources')], [ROOT]: [dir('Tools')], [`${ROOT}/Tools`]: [file('item.md')] };
  native.isTauriRuntime.mockReturnValue(true);
  native.readDir.mockImplementation(async (path: string) => { if (!tree[path]) throw Error('private details'); return tree[path]; });
  native.stat.mockResolvedValue({ isFile: true, isDirectory: false, isSymlink: false, size: 10 });
  native.readTextFile.mockResolvedValue('# Tool\n\nSummary.');
});
describe('native read-only Resources boundary (synthetic plugin)', () => {
  it('uses only fixed Home paths and the listed regular file', async () => {
    const result = await loadMemoryResources();
    expect(result.notes[0]).toMatchObject({ fileName: 'Tools/item.md', category: 'Tools' });
    for (const [, options] of native.readDir.mock.calls) expect(options).toEqual({ baseDir: 21 });
    expect(native.readTextFile).toHaveBeenCalledExactlyOnceWith(`${ROOT}/Tools/item.md`, { baseDir: 21 });
  });
  it('refuses browser access without probing disk', async () => {
    native.isTauriRuntime.mockReturnValue(false);
    await expect(loadMemoryResources()).rejects.toMatchObject({ code: 'unsupported' });
    expect(native.readDir).not.toHaveBeenCalled();
  });
  it('distinguishes missing root and private listing failure', async () => {
    tree['MOTHER/MEMORY'] = [];
    await expect(loadMemoryResources()).rejects.toMatchObject({ code: 'missing' });
    native.readDir.mockRejectedValue(Error('private details'));
    await expect(loadMemoryResources()).rejects.toMatchObject({ code: 'read', message: 'Memory Notes: read' });
  });
  it.each(['MOTHER', 'MEMORY', 'Resources'])('does not traverse linked fixed ancestor %s', async (name) => {
    for (const entries of Object.values(tree)) for (const entry of entries) if (entry.name === name) entry.isSymlink = true;
    await expect(loadMemoryResources()).rejects.toMatchObject({ code: 'read' });
    expect(native.readTextFile).not.toHaveBeenCalled();
    expect(native.readDir).not.toHaveBeenCalledWith(ROOT, expect.anything());
  });
  it('never follows linked category or file entries', async () => {
    tree[ROOT] = [{ ...dir('Tools'), isSymlink: true }, { ...file('linked.md'), isSymlink: true }];
    const result = await loadMemoryResources();
    expect(result.issues).toHaveLength(2);
    expect(native.readTextFile).not.toHaveBeenCalled();
    expect(native.readDir).not.toHaveBeenCalledWith(`${ROOT}/Tools`, expect.anything());
  });
  it('revalidates parent listings before reading, rejecting a newly linked category', async () => {
    native.stat.mockImplementation(async () => { tree[ROOT] = [{ ...dir('Tools'), isSymlink: true }]; return { isFile: true, isDirectory: false, isSymlink: false, size: 10 }; });
    expect((await loadMemoryResources()).issues).toEqual([{ fileName: 'Tools/item.md', reason: 'read' }]);
    expect(native.readTextFile).not.toHaveBeenCalled();
  });
  it('checks size before opening and after UTF-8 decoding', async () => {
    native.stat.mockResolvedValue({ isFile: true, isDirectory: false, isSymlink: false, size: 1_048_577 });
    expect((await loadMemoryResources()).issues[0].reason).toBe('tooLarge');
    expect(native.readTextFile).not.toHaveBeenCalled();
    native.stat.mockResolvedValue({ isFile: true, isDirectory: false, isSymlink: false, size: 10 });
    native.readTextFile.mockResolvedValue('ü'.repeat(524_289));
    expect((await loadMemoryResources()).issues[0].reason).toBe('tooLarge');
  });
  it('fails closed on nonregular stat results', async () => {
    native.stat.mockResolvedValue({ isFile: false, isDirectory: true, isSymlink: false, size: 10 });
    expect((await loadMemoryResources()).issues[0].reason).toBe('read');
    expect(native.readTextFile).not.toHaveBeenCalled();
  });
});
