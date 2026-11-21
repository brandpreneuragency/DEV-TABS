import { useEffect, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Color from '@tiptap/extension-color';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { useTranslation } from 'react-i18next';
import type { NoteDraft } from '../../types/notes';
import { useNotesStore } from '../../stores/notesStore';
import { InlineTextPreset } from '../editor/InlineTextPreset';
import { SelectionToolbar } from '../editor/SelectionToolbar';

export function NoteRichEditor({ draft, disabled }: { draft: NoteDraft; disabled: boolean }) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, horizontalRule: false, blockquote: false, link: { openOnClick: false } }),
      TextAlign.configure({ types: ['paragraph'] }),
      TextStyle,
      InlineTextPreset,
      Color,
      Placeholder.configure({ placeholder: t('notes.bodyPlaceholder') }),
    ],
    content: draft.content,
    editable: !disabled,
    editorProps: { attributes: { class: 'notes-rich-text', role: 'textbox', 'aria-multiline': 'true', 'aria-label': t('notes.noteBody') } },
    onUpdate: ({ editor: current }) => useNotesStore.getState().updateDraft(draft.id, { content: current.getJSON() }),
  }, [draft.id]);
  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);
  if (!editor) return null;
  return <>
    <EditorContent ref={bodyRef} editor={editor} className="notes-editor-body" />
    {!disabled && <SelectionToolbar editor={editor} editorScrollRef={bodyRef} />}
  </>;
}
