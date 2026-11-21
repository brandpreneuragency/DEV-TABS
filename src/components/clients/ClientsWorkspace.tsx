import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { db, type TabsDB } from '../../services/db';
import { createClientRecords } from '../../services/clients/records';
import type { ClientRecordsAdapter } from '../../hooks/useClientAutosave';
import { isNoClient } from '../../stores/clientOverview';
import { useClientDetailsStore } from '../../stores/clientDetailsStore';
import { useClientStore } from '../../stores/clientStore';
import { useTaskStore } from '../../stores/taskStore';
import { ClientOverview } from './ClientOverview';
import { ClientProfile } from './ClientProfile';
import { ClientNotes } from './ClientNotes';
import type { ClientNote } from '../../types/clients';
import './clients.css';

interface ClientsWorkspaceProps {
  database?: TabsDB;
  records?: ClientRecordsAdapter;
}

const defaultRecords = createClientRecords(db);

export function ClientsWorkspace({ database = db, records }: ClientsWorkspaceProps = {}) {
  const { t } = useTranslation();
  const [noteTarget, setNoteTarget] = useState<{ clientId: string; noteId: string } | null>(null);
  const category = useClientDetailsStore((state) => state.category);
  const setCategory = useClientDetailsStore((state) => state.setCategory);
  const clients = useClientStore((state) => state.clients);
  const selectedClientId = useTaskStore((state) => state.selectedClientId);
  const selectedClient = clients.find((client) => client.id === selectedClientId);
  const liveClient = selectedClient && !isNoClient(selectedClient) ? selectedClient : null;
  const isNoClientScope = Boolean(selectedClient && isNoClient(selectedClient));
  const clientRecords = useMemo(() => records ?? (database === db ? defaultRecords : createClientRecords(database)), [database, records]);
  const identity = selectedClientId === null
    ? t('clients.everythingScope')
    : isNoClientScope
      ? t('clients.noClientScope')
      : selectedClient?.name ?? t('clients.unavailableBrand');
  const categoryTitle = category === 'overview' ? t('clients.overview')
    : category === 'profile' ? t('clients.profile') : t('clients.notes');
  const viewNotes = () => { setNoteTarget(null); setCategory('notes'); };
  const openNote = (note: ClientNote) => {
    useTaskStore.getState().setSelection(note.clientId, null);
    setNoteTarget({ clientId: note.clientId, noteId: note.id });
    setCategory('notes');
  };

  return (
    <section className="ui-panel-body clients-workspace" aria-label={t('clients.categoryPanelLabel', { category: categoryTitle, identity })}>
      {category !== 'overview' && <header className="ui-toolbar clients-workspace-header">
        <div className="clients-toolbar-identity"><h1>{categoryTitle}</h1><span>{identity}</span></div>
        <button type="button" className="ui-button clients-button" onClick={() => setCategory('overview')}>{t('clients.overview')}</button>
      </header>}
      <div id="clients-workspace-category" className="clients-workspace-content" role="tabpanel" tabIndex={0}
        aria-label={t('clients.categoryPanelLabel', { category: categoryTitle, identity })}>
        {category === 'overview' && <ClientOverview clientId={selectedClientId} records={clientRecords}
          onViewNotes={viewNotes} onOpenNote={openNote}
          onCreateNote={!isNoClientScope && (selectedClientId === null || liveClient !== null)
            ? viewNotes : undefined}
          onProfile={liveClient ? () => setCategory('profile') : undefined} />}
        {category === 'profile' && <ClientProfile client={liveClient} records={clientRecords} database={database} />}
        {category === 'notes' && <ClientNotes clientId={selectedClientId} records={clientRecords} database={database}
          focusNoteId={noteTarget?.clientId === selectedClientId ? noteTarget.noteId : undefined} />}
      </div>
    </section>
  );
}
