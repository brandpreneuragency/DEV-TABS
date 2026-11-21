import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { parseByExt, serialize } from '../../services/fileFormat';
import { getEditorStateCache } from '../../stores/workspaceStore';
import { TipTapEditor } from './TipTapEditor';

afterEach(() => {
  cleanup();
  getEditorStateCache().clear();
});

async function openSource(text: string, extension = 'json') {
  let editor: Editor | undefined;
  const view = render(<TipTapEditor
    fileId={`C:/Fixtures/source.${extension}`}
    workspaceId={null}
    initialContent={JSON.stringify(parseByExt(text, extension))}
    onEditorReady={(ready) => { editor = ready; }}
  />);
  await waitFor(() => expect(editor).toBeDefined());
  return { editor: editor!, ...view };
}

describe('source files in the documents editor', () => {
  it('retains the raw-file format through the real editor and an edit', async () => {
    const text = '{\n  "name": "Pure Black"\n}\n';
    const { editor, container } = await openSource(text);

    expect(container.querySelector('pre code')?.textContent).toBe(text);
    expect(serialize(editor.getJSON(), 'json')).toBe(text);

    act(() => {
      editor.view.dispatch(editor.state.tr.insertText(' theme', 24));
    });

    expect(serialize(editor.getJSON(), 'json')).toBe(text.slice(0, 23) + ' theme' + text.slice(23));
    expect(editor.state.doc.childCount).toBe(1);
  });

  it('keeps repeated Enter presses inside the source block without removing blank lines', async () => {
    const { editor } = await openSource('value', 'txt');
    act(() => { editor.commands.setTextSelection(6); });

    for (let index = 0; index < 3; index++) {
      fireEvent.keyDown(editor.view.dom, { key: 'Enter', code: 'Enter' });
    }

    expect(serialize(editor.getJSON(), 'txt')).toBe('value\n\n\n');
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.isActive('codeBlock')).toBe(true);
  });

  it.each(['', '\r\n\tfirst  \r\n\r\nsecond\r\n'])('round-trips literal text through the editor: %j', async (text) => {
    const { editor } = await openSource(text, 'txt');
    expect(serialize(editor.getJSON(), 'txt')).toBe(text);
    expect(editor.view.dom.getAttribute('spellcheck')).toBe('false');
  });

  it('does not leak source-file identity or undo into a native JSON document on file swap', async () => {
    const text = '{\n  "value": 1\n}\n';
    const { editor, rerender } = await openSource(text);
    const native = {
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: 'json' }, content: [{ type: 'text', text: '{}' }] }],
    };
    rerender(<TipTapEditor fileId="C:/Fixtures/native.json" workspaceId={null}
      initialContent={JSON.stringify(parseByExt(JSON.stringify(native), 'json'))} />);

    expect(JSON.parse(serialize(editor.getJSON(), 'json'))).toMatchObject(native);
    expect(editor.can().undo()).toBe(false);
    expect(editor.view.dom.hasAttribute('data-text-file')).toBe(false);

    rerender(<TipTapEditor fileId="C:/Fixtures/source.json" workspaceId={null}
      initialContent={JSON.stringify(parseByExt(text, 'json'))} />);
    expect(serialize(editor.getJSON(), 'json')).toBe(text);
  });
});
