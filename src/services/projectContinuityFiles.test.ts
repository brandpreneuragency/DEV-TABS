import { beforeEach, expect, it, vi } from 'vitest';
import * as fs from './fs-adapter';
import { selectContinuityFile, readContinuityFile } from './projectContinuityFiles';
vi.mock('./runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('./fs-adapter', () => ({ openFileDialog: vi.fn(), getMetadata: vi.fn(), readTextFile: vi.fn() }));
const path = 'C:/fixture/docs/work/topic.md';
const metadata = { isFile: true, isDirectory: false, size: 20, modifiedAt: new Date(1000) };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fs.openFileDialog).mockResolvedValue(path);
  vi.mocked(fs.getMetadata).mockResolvedValue(metadata);
  vi.mocked(fs.readTextFile).mockResolvedValue('# Next\nOwner trial');
});
it('selection saves a reference without reading; preview reselects the exact file and reads plain text', async () => {
  expect(await selectContinuityFile()).toBe(path);
  expect(fs.readTextFile).not.toHaveBeenCalled();
  const result = await readContinuityFile(path);
  expect(result?.text).toBe('# Next\nOwner trial');
  expect(result?.modifiedAt).toBe(1000);
  expect(fs.readTextFile).toHaveBeenCalledExactlyOnceWith(path);
});
it('cancel and mismatched selection never read', async () => {
  vi.mocked(fs.openFileDialog).mockResolvedValueOnce(null).mockResolvedValueOnce('C:/other/topic.md');
  expect(await readContinuityFile(path)).toBeNull();
  await expect(readContinuityFile(path)).rejects.toThrow('continuity.mismatch');
  expect(fs.readTextFile).not.toHaveBeenCalled();
});
it('rejects unsafe persisted paths before opening a picker', async () => {
  await expect(readContinuityFile('C:/VAULT/a.md')).rejects.toThrow('continuity.invalid');
  expect(fs.openFileDialog).not.toHaveBeenCalled();
});
it('rejects oversized files before reading', async () => {
  vi.mocked(fs.getMetadata).mockResolvedValue({ ...metadata, size: 300_000 });
  await expect(readContinuityFile(path)).rejects.toThrow('continuity.tooLarge');
  expect(fs.readTextFile).not.toHaveBeenCalled();
});
it('rejects a changing file and never returns a misleading snapshot', async () => {
  vi.mocked(fs.getMetadata).mockResolvedValueOnce(metadata).mockResolvedValueOnce({ ...metadata, modifiedAt: new Date(2000) });
  await expect(readContinuityFile(path)).rejects.toThrow('continuity.changed');
});
it('propagates unavailable files rather than returning old content', async () => {
  vi.mocked(fs.getMetadata).mockRejectedValue(new Error('missing'));
  await expect(readContinuityFile(path)).rejects.toThrow();
  expect(fs.readTextFile).not.toHaveBeenCalled();
});
