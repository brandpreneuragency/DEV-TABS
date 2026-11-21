// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readMemoryNotes } from './reader';

const file = (name: string) => ({ name, isFile: true, isDirectory: false, isSymlink: false });

describe('Memory Notes read boundary', () => {
  it('reads only direct owner Markdown notes and reports conflict copies without opening them', async () => {
    const source = {
      list: vi.fn(async () => [
        file('a.md'), file('B.MD'), file('AGENTS.md'), file('README.md'), file('.hidden.md'),
        file('photo.png'), file('../Personal/private.md'), file('C:\\outside.md'),
        file('note.sync-conflict-20261029-device.md'),
        { ...file('linked.md'), isSymlink: true },
        { ...file('subfolder'), isFile: false, isDirectory: true },
      ]),
      read: vi.fn(async (name: string) => `# ${name}\n\nA local note.`),
    };
    const result = await readMemoryNotes(source);
    expect(source.list).toHaveBeenCalledOnce();
    expect(source.read.mock.calls.map(([name]) => name)).toEqual(['a.md', 'B.MD']);
    expect(result.notes.map((note) => note.fileName)).toEqual(['a.md', 'B.MD']);
    expect(result.issues).toEqual([
      { fileName: '../Personal/private.md', reason: 'unsafe' },
      { fileName: 'C:\\outside.md', reason: 'unsafe' },
      { fileName: 'note.sync-conflict-20261029-device.md', reason: 'conflict' },
      { fileName: 'linked.md', reason: 'unsafe' },
    ]);
  });
});
