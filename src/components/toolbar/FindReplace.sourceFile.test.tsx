import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, expect, it } from 'vitest';
import { SourceFileFormat } from '../editor/SourceFileFormat';
import { parseByExt, serialize } from '../../services/fileFormat';
import { useUIStore } from '../../stores/uiStore';
import { FindReplace } from './FindReplace';

afterEach(() => {
  cleanup();
  useUIStore.setState({ findReplaceOpen: false });
});

it('preserves literal replacement text and whitespace in the alternate find/replace panel', () => {
  const source = '{\n\t"name": "Old"\n}\n';
  const editor = new Editor({ extensions: [StarterKit, SourceFileFormat], content: parseByExt(source, 'json') });
  try {
    useUIStore.setState({ findReplaceOpen: true });
    render(<FindReplace editor={editor} />);
    fireEvent.change(screen.getByPlaceholderText('Find...'), { target: { value: 'Old' } });
    fireEvent.change(screen.getByPlaceholderText('Replace with...'), { target: { value: '<New>' } });
    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(serialize(editor.getJSON(), 'json')).toBe(source.replace('Old', '<New>'));
  } finally {
    editor.destroy();
  }
});
