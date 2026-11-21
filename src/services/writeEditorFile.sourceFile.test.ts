import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it, vi } from 'vitest';
import { SourceFileFormat } from '../components/editor/SourceFileFormat';
import { parseByExt, serialize } from './fileFormat';
import { readTextFile } from './fs-adapter';
import { writeEditorContent } from './writeEditorFile';

// Exercise the real writer, FS adapter and desktop connector. Only the native
// plugin boundary is replaced with real I/O in a disposable fixture directory.
vi.mock('@tauri-apps/plugin-fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tauri-apps/plugin-fs')>();
  const fs = await import('node:fs/promises');
  return {
    ...original,
    readTextFile: (path: string) => fs.readFile(path, 'utf8'),
    writeTextFile: (path: string, text: string) => fs.writeFile(path, text, 'utf8'),
  };
});
vi.mock('./runtime', async (importOriginal) => {
  const original = await importOriginal<typeof import('./runtime')>();
  const { TauriFolderConnector } = await import('./tauri-folder-connector');
  const connector = new TauriFolderConnector();
  return { ...original, getFolderConnector: async () => connector };
});

describe('source-file disk round trip through the desktop adapter', () => {
  it.each(['json', 'txt', 'yaml', 'py', 'html'])('opens, edits, saves and reopens .%s without a document wrapper', async (ext) => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tabs-source-roundtrip-'));
    const path = join(root, `manifest.${ext}`);
    const source = '{\r\n\t"name": "Pure Black",\r\n\r\n  "html": "<div>literal & text</div>"\r\n}\r\n';
    let editor: Editor | undefined;
    let reopened: Editor | undefined;
    try {
      await writeFile(path, source, 'utf8');
      editor = new Editor({
        extensions: [StarterKit, SourceFileFormat],
        content: parseByExt(await readTextFile(path), ext),
      });
      await writeEditorContent(path, editor.getJSON());
      expect(await readFile(path)).toEqual(Buffer.from(source, 'utf8'));

      const start = source.indexOf('Pure Black') + 1;
      editor.view.dispatch(editor.state.tr.insertText('Pure White', start, start + 'Pure Black'.length));
      await writeEditorContent(path, editor.getJSON());
      const expected = source.replace('Pure Black', 'Pure White');
      expect(await readFile(path)).toEqual(Buffer.from(expected, 'utf8'));

      reopened = new Editor({
        extensions: [StarterKit, SourceFileFormat],
        content: parseByExt(await readTextFile(path), ext),
      });
      expect(serialize(reopened.getJSON(), ext)).toBe(expected);
      expect(reopened.state.doc.firstChild?.type.name).toBe('codeBlock');
    } finally {
      editor?.destroy();
      reopened?.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps an existing native TipTap JSON file in document format', async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tabs-native-roundtrip-'));
    const path = join(root, 'document.json');
    const native = {
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: 'json' }, content: [{ type: 'text', text: '{}' }] }],
    };
    let editor: Editor | undefined;
    try {
      await writeFile(path, JSON.stringify(native), 'utf8');
      editor = new Editor({
        extensions: [StarterKit, SourceFileFormat],
        content: parseByExt(await readTextFile(path), 'json'),
      });
      await writeEditorContent(path, editor.getJSON());
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(native);
    } finally {
      editor?.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });
});
