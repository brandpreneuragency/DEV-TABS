// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMemoryNotes } from './desktop';
import { MEMORY_NOTES_DIRECTORY } from './reader';

const native = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => true), exists: vi.fn(), readDir: vi.fn(), readTextFile: vi.fn(), stat: vi.fn(),
}));
vi.mock('../runtime', () => ({ isTauriRuntime: native.isTauriRuntime }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { Home: 21 }, exists: native.exists, readDir: native.readDir,
  readTextFile: native.readTextFile, stat: native.stat,
}));

beforeEach(() => {
  vi.clearAllMocks();
  native.isTauriRuntime.mockReturnValue(true);
  native.exists.mockResolvedValue(true);
  native.readDir.mockResolvedValue([{ name: 'note.md', isFile: true, isDirectory: false, isSymlink: false }]);
  native.stat.mockResolvedValue({ size: 100, isFile: true, isSymlink: false });
  native.readTextFile.mockResolvedValue('# Note\n\nLocal content.');
});

describe('Memory Notes desktop adapter', () => {
  it('binds every filesystem call to Home/MOTHER/MEMORY/Notes without a caller-provided path', async () => {
    const snapshot = await loadMemoryNotes();
    expect(snapshot.notes[0].title).toBe('Note');
    expect(native.exists).toHaveBeenCalledExactlyOnceWith(MEMORY_NOTES_DIRECTORY, { baseDir: 21 });
    expect(native.readDir).toHaveBeenCalledExactlyOnceWith(MEMORY_NOTES_DIRECTORY, { baseDir: 21 });
    expect(native.stat).toHaveBeenCalledExactlyOnceWith(`${MEMORY_NOTES_DIRECTORY}/note.md`, { baseDir: 21 });
    expect(native.readTextFile).toHaveBeenCalledExactlyOnceWith(`${MEMORY_NOTES_DIRECTORY}/note.md`, { baseDir: 21 });
  });
  it('never probes filesystem APIs in browser preview', async () => {
    native.isTauriRuntime.mockReturnValue(false);
    await expect(loadMemoryNotes()).rejects.toMatchObject({ code: 'unsupported' });
    expect(native.exists).not.toHaveBeenCalled();
  });
  it('distinguishes a missing folder from denied access', async () => {
    native.exists.mockResolvedValue(false);
    await expect(loadMemoryNotes()).rejects.toMatchObject({ code: 'missing' });
    native.exists.mockRejectedValue(new Error('private backend error'));
    await expect(loadMemoryNotes()).rejects.toMatchObject({ code: 'read' });
    expect(native.readDir).not.toHaveBeenCalled();
  });
  it('does not open oversized files and reports the omitted item', async () => {
    native.stat.mockResolvedValue({ size: 1_048_577, isFile: true, isSymlink: false });
    expect(await loadMemoryNotes()).toEqual({ notes: [], issues: [{ fileName: 'note.md', reason: 'tooLarge' }] });
    expect(native.readTextFile).not.toHaveBeenCalled();
  });
});
