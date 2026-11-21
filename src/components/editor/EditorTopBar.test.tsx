import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';
import { useUIStore } from '../../stores/uiStore';
import { EditorTopBar } from './EditorTopBar';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { SourceFileFormat } from './SourceFileFormat';
import { parseByExt, serialize } from '../../services/fileFormat';

afterEach(cleanup);

function setup() {
  render(<I18nextProvider i18n={i18n}><EditorTopBar editor={null} onSave={vi.fn()} /></I18nextProvider>);
  return screen.getByRole('button', { name: 'More' });
}

describe('Editor overflow menu', () => {
  it('hides actions until opened and preserves disabled history actions', () => {
    const trigger = setup();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Redo' })).toBeDisabled();
    expect(screen.getByRole('menuitemcheckbox')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Find & Replace' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('toggles rainbow and dismisses on outside click', () => {
    const trigger = setup();
    const before = useUIStore.getState().rainbowMode;
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitemcheckbox'));
    expect(useUIStore.getState().rainbowMode).toBe(!before);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    useUIStore.setState({ rainbowMode: before });
  });

  it('opens find independently of the dismissed menu', async () => {
    fireEvent.click(setup());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Find & Replace' }));
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(screen.getByPlaceholderText('Find')).toHaveFocus());
    fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'example' } });
    expect(screen.getByPlaceholderText('Find')).toHaveValue('example');
  });

  it.each(['Replace all', 'Replace current'].flatMap((action) =>
    ['<New>', '<b>New</b>', '<div>New</div>', 'A &amp; B', '', '$&'].map((replacement) => ({ action, replacement })),
  ))('$action inserts literal source replacement $replacement', ({ action, replacement }) => {
    const source = '{\n  "name": "Old",\n  "html": "<div>Old</div>"\n}\n';
    const editor = new Editor({ extensions: [StarterKit, SourceFileFormat], content: parseByExt(source, 'json') });
    try {
      render(<I18nextProvider i18n={i18n}><EditorTopBar editor={editor} onSave={vi.fn()} /></I18nextProvider>);
      fireEvent.click(screen.getByRole('button', { name: 'More' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Find & Replace' }));
      fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'Old' } });
      fireEvent.change(screen.getByPlaceholderText('Replace'), { target: { value: replacement } });
      fireEvent.click(screen.getByTitle(action));

      const expected = action === 'Replace all'
        ? source.replaceAll('Old', () => replacement) : source.replace('Old', () => replacement);
      expect(serialize(editor.getJSON(), 'json')).toBe(expected);
      expect(editor.state.doc.childCount).toBe(1);
      expect(editor.state.doc.firstChild?.type.name).toBe('codeBlock');
    } finally {
      editor.destroy();
    }
  });
});
