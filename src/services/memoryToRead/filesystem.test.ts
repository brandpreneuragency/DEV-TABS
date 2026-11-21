// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readMemoryToRead } from './reader';

describe('To-Read real filesystem fixture', () => {
  it('reads only supported records and preserves original bytes and reading status', async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tabs-to-read-'));
    const original = '---\r\ntitle: "Reading"\r\nstatus: review\r\nsource: "https://example.invalid/post"\r\n---\r\n## Kısaca\r\n\r\nOriginal introduction.\r\n';
    try {
      await mkdir(join(root, 'Bundle', 'assets'), { recursive: true });
      await mkdir(join(root, 'References'));
      await writeFile(join(root, 'reading.md'), original);
      await writeFile(join(root, 'AGENTS.md'), 'Instructions are not a card.');
      await writeFile(join(root, 'Bundle', 'main.md'), '# Bundled record');
      await writeFile(join(root, 'Bundle', 'assets', 'extra.md'), 'Not another reading card.');
      const read = vi.fn((path: string) => readFile(join(root, path), 'utf8'));
      const snapshot = await readMemoryToRead({
        list: async (path) => (await readdir(join(root, path), { withFileTypes: true })).map((entry) => ({
          name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), isSymlink: entry.isSymbolicLink(),
        })), read,
      });
      expect(snapshot.notes.map((note) => note.fileName).sort()).toEqual(['Bundle/main.md', 'reading.md']);
      expect(snapshot.issues).toEqual([]);
      expect(read.mock.calls.map(([path]) => path).sort()).toEqual(['Bundle/main.md', 'reading.md']);
      expect(snapshot.notes.find((note) => note.fileName === 'reading.md')?.sourceUrl).toBe('https://example.invalid/post');
      expect(await readFile(join(root, 'reading.md'), 'utf8')).toBe(original);
      expect(await readFile(join(root, 'Bundle', 'assets', 'extra.md'), 'utf8')).toBe('Not another reading card.');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
