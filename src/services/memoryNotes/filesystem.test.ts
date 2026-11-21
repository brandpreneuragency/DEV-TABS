// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMemoryNotes } from './reader';

// The real reader against a disposable filesystem, not the owner's collection.
describe('Memory Notes filesystem fixture', () => {
  it('refreshes changed/new/deleted Markdown without writing or visiting sibling collections', async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tabs-memory-notes-'));
    const notes = join(root, 'Notes');
    const sibling = join(root, 'Personal');
    const opened: string[] = [];
    try {
      await mkdir(notes); await mkdir(sibling);
      await writeFile(join(notes, 'AGENTS.md'), 'Guidance, not a card.');
      await writeFile(join(notes, 'first.md'), '# First\n\nBefore.');
      await writeFile(join(sibling, 'excluded.md'), 'Out of scope.');
      const source = {
        list: async () => (await readdir(notes, { withFileTypes: true })).map((entry) => ({
          name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), isSymlink: entry.isSymbolicLink(),
        })),
        read: async (name: string) => { opened.push(name); return readFile(join(notes, name), 'utf8'); },
      };
      expect((await readMemoryNotes(source)).notes.map((note) => note.title)).toEqual(['First']);
      expect(await readFile(join(notes, 'first.md'), 'utf8')).toBe('# First\n\nBefore.');
      await writeFile(join(notes, 'first.md'), '# First\n\nAfter.');
      await writeFile(join(notes, 'second.md'), '# Second');
      const changed = await readMemoryNotes(source);
      expect(changed.notes).toHaveLength(2);
      expect(changed.notes.find((note) => note.fileName === 'first.md')?.preview).toBe('After.');
      await rm(join(notes, 'first.md'));
      expect((await readMemoryNotes(source)).notes.map((note) => note.title)).toEqual(['Second']);
      expect(opened.every((name) => name === 'first.md' || name === 'second.md')).toBe(true);
      expect(await readFile(join(notes, 'AGENTS.md'), 'utf8')).toBe('Guidance, not a card.');
      expect(await readFile(join(sibling, 'excluded.md'), 'utf8')).toBe('Out of scope.');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
