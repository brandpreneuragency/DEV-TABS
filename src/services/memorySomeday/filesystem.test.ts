// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readMemorySomeday } from './reader';

describe('Someday real filesystem fixture', () => {
  it('preserves idea and asset bytes and does not open root or asset records', async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tabs-someday-'));
    const original = '---\r\ncreated: null\r\nupdated: null\r\n---\r\n# Idea\r\n\r\nA future idea.\r\n';
    try {
      await mkdir(join(root, 'Idea', 'assets'), { recursive: true });
      await writeFile(join(root, 'Idea', 'idea.md'), original);
      await writeFile(join(root, 'Idea', 'assets', 'extra.md'), 'Keep asset.');
      await writeFile(join(root, 'stray.md'), 'Not an idea folder.');
      const read = vi.fn((path: string) => readFile(join(root, path), 'utf8'));
      const result = await readMemorySomeday({
        list: async (path) => (await readdir(join(root, path), { withFileTypes: true })).map((entry) => ({
          name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), isSymlink: entry.isSymbolicLink(),
        })), read,
      });
      expect(result.notes.map((note) => note.fileName)).toEqual(['Idea/idea.md']);
      expect(result.issues).toEqual([]);
      expect(read.mock.calls.map(([path]) => path)).toEqual(['Idea/idea.md']);
      expect(await readFile(join(root, 'Idea', 'idea.md'), 'utf8')).toBe(original);
      expect(await readFile(join(root, 'Idea', 'assets', 'extra.md'), 'utf8')).toBe('Keep asset.');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
