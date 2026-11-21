import { BookOpen, Bookmark, Library, Lightbulb, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isTauriRuntime } from '../../services/runtime';
import { useMemoryNotesStore } from '../../stores/memoryNotesStore';
import { useMemoryResourcesStore } from '../../stores/memoryResourcesStore';
import { useMemoryToReadStore } from '../../stores/memoryToReadStore';
import { useMemorySomedayStore } from '../../stores/memorySomedayStore';
import { useMemoryNavigationStore } from '../../stores/memoryNavigationStore';

export function MemoryNotesNavigation() {
  const { t } = useTranslation();
  const desktop = isTauriRuntime();
  const page = useMemoryNavigationStore((state) => state.page);
  const notesLoading = useMemoryNotesStore((state) => state.loading);
  const resourcesLoading = useMemoryResourcesStore((state) => state.loading);
  const toReadLoading = useMemoryToReadStore((state) => state.loading);
  const somedayLoading = useMemorySomedayStore((state) => state.loading);
  const notesError = useMemoryNotesStore((state) => state.error);
  const resourcesError = useMemoryResourcesStore((state) => state.error);
  const toReadError = useMemoryToReadStore((state) => state.error);
  const somedayError = useMemorySomedayStore((state) => state.error);
  const loading = notesLoading || resourcesLoading || toReadLoading || somedayLoading;
  const failedCollections = [
    page !== 'notes' && notesError && t('memoryNotes.notes'),
    page !== 'resources' && resourcesError && t('memoryResources.resources'),
    page !== 'toRead' && toReadError && t('memoryToRead.toRead'),
    page !== 'someday' && somedayError && t('memorySomeday.someday'),
  ].filter(Boolean);
  const refreshAll = () => {
    void Promise.all([
      useMemoryNotesStore.getState().load(),
      useMemoryResourcesStore.getState().load(),
      useMemoryToReadStore.getState().load(),
      useMemorySomedayStore.getState().load(),
    ]);
  };
  const setPage = (next: typeof page) => useMemoryNavigationStore.getState().setPage(next);
  return <>
    <div className="nav-bar-header">
      <div className="nav-bar-toolbar">
        <button type="button" className="ui-button nav-header-action" disabled={!desktop || loading} aria-busy={loading}
          aria-label={t('memoryNotes.refreshAllLabel')} title={t('memoryNotes.refreshAllLabel')} onClick={refreshAll}>
          <RefreshCw aria-hidden="true" /><span>{t(loading ? 'memoryNotes.refreshingAll' : 'memoryNotes.refreshAll')}</span>
        </button>
      </div>
      {desktop && !loading && failedCollections.length > 0 && <p className="memory-refresh-error" role="alert">
        {t('memoryNotes.refreshFailed')}: {failedCollections.join(', ')}
      </p>}
    </div>
    <div className="scope-tabs memory-scope-tabs">
      <button type="button" className="ui-list-row scope-tab" aria-current={page === 'notes' ? 'page' : undefined}
        onClick={() => { useMemoryNotesStore.getState().select(null); setPage('notes'); }}><BookOpen /><span>{t('memoryNotes.notes')}</span></button>
      <button type="button" className="ui-list-row scope-tab" aria-current={page === 'resources' ? 'page' : undefined}
        onClick={() => { useMemoryResourcesStore.getState().select(null); setPage('resources'); }}><Library /><span>{t('memoryResources.resources')}</span></button>
      <button type="button" className="ui-list-row scope-tab" aria-current={page === 'toRead' ? 'page' : undefined}
        onClick={() => { useMemoryToReadStore.getState().select(null); setPage('toRead'); }}><Bookmark /><span>{t('memoryToRead.toRead')}</span></button>
      <button type="button" className="ui-list-row scope-tab" aria-current={page === 'someday' ? 'page' : undefined}
        onClick={() => { useMemorySomedayStore.getState().select(null); setPage('someday'); }}><Lightbulb /><span>{t('memorySomeday.someday')}</span></button>
    </div>
  </>;
}
