import { Layers, Pin, Tags } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotesStore } from '../../stores/notesStore';
import { NotesCategoryManager } from './NotesCategoryManager';

export function NotesNavigation() {
  const { t } = useTranslation();
  const categories = useNotesStore((state) => state.categories);
  const filter = useNotesStore((state) => state.categoryFilter);
  const pinnedOnly = useNotesStore((state) => state.pinnedOnly);
  const managerOpen = useNotesStore((state) => state.categoryManagerOpen);
  const managerButtonRef = useRef<HTMLButtonElement>(null);
  const select = (id: string | null, pinned = false) => {
    useNotesStore.getState().setCategoryFilter(id);
    useNotesStore.getState().setPinnedOnly(pinned);
  };
  return <>
    <div className="nav-bar-header"><div className="nav-bar-toolbar">
      <button ref={managerButtonRef} type="button" className="ui-button notes-button nav-header-action" title={t('notes.manageCategories')}
        onClick={() => useNotesStore.getState().setCategoryManagerOpen(true)}><Tags /><span>{t('notes.manageCategories')}</span></button>
    </div></div>
    <div className="scope-tabs notes-scope-tabs">
      <button type="button" className="ui-list-row scope-tab" aria-current={!filter && !pinnedOnly ? 'page' : undefined} onClick={() => select(null)}>
        <Layers /><span>{t('notes.allNotes')}</span></button>
      <button type="button" className="ui-list-row scope-tab" aria-current={pinnedOnly ? 'page' : undefined} onClick={() => select(null, true)}>
        <Pin /><span>{t('notes.pinned')}</span></button>
      <div className="notes-scope-label">{t('notes.categories')}</div>
      {[...categories].sort((left, right) => left.name.localeCompare(right.name)).map((category) => <button key={category.id}
        type="button" className="ui-list-row scope-tab" aria-current={filter === category.id && !pinnedOnly ? 'page' : undefined}
        onClick={() => select(category.id)}><span className="notes-category-dot" data-color={category.color} /><span>{category.name}</span></button>)}
      <button type="button" className="ui-list-row scope-tab" aria-current={filter === '__uncategorized__' ? 'page' : undefined}
        onClick={() => select('__uncategorized__')}><span className="notes-category-dot" data-color="neutral" /><span>{t('notes.uncategorized')}</span></button>
    </div>
    {managerOpen && <NotesCategoryManager anchorRef={managerButtonRef} />}
  </>;
}
