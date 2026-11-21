import { useEffect, useMemo, useState } from 'react';
import { liveQuery } from 'dexie';
import { ArrowUpRight, CalendarDays, FolderOpen, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ClientNote } from '../../types/clients';
import type { Project, Task } from '../../types';
import type { ClientRecordsAdapter } from '../../hooks/useClientAutosave';
import { isNoClient } from '../../stores/clientOverview';
import { useClientStore } from '../../stores/clientStore';
import { useProjectStore } from '../../stores/projectStore';
import { useTaskStore } from '../../stores/taskStore';
import { useUIStore } from '../../stores/uiStore';
import { selectClientOverviewNotes, selectClientOverviewWork, selectClientPortfolio } from '../../services/clients/selectors';
import { parseIsoDateToLocal, toLocalIsoDate } from '../taskManager/taskMetadataUtils';
import { ClientContextSummary } from './ClientContextSummary';
import { ClientDirectory } from './ClientDirectory';
import { ClientNotePreview } from './ClientNotePreview';
import './clients.css';

interface ClientOverviewProps {
  clientId: string | null;
  records: ClientRecordsAdapter;
  onViewNotes: () => void;
  onCreateNote?: () => void;
  onProfile?: () => void;
  onOpenNote?: (note: ClientNote) => void;
}

type NotesState =
  | { scope: string; status: 'loading' }
  | { scope: string; status: 'error' }
  | { scope: string; status: 'ready'; notes: ClientNote[] };

function scopeKey(clientId: string | null): string {
  return clientId === null ? 'everything' : clientId;
}

function noteDisplayName(note: ClientNote, clients: ReturnType<typeof useClientStore.getState>['clients']): string {
  return clients.find((client) => client.id === note.clientId)?.name ?? note.clientId;
}

export function ClientOverview({ clientId, records, onViewNotes, onCreateNote, onProfile, onOpenNote }: ClientOverviewProps) {
  const { t, i18n } = useTranslation();
  const projects = useProjectStore((state) => state.projects);
  const tasks = useTaskStore((state) => state.tasks);
  const clients = useClientStore((state) => state.clients);
  const client = clients.find((entry) => entry.id === clientId);
  const isLiveBrand = Boolean(client && !isNoClient(client));
  const key = scopeKey(clientId);
  const [query, setQuery] = useState('');
  const [retry, setRetry] = useState(0);
  const [taskLimit, setTaskLimit] = useState(6);
  const [today, setToday] = useState(() => toLocalIsoDate(new Date()));
  useEffect(() => {
    const refresh = () => setToday(toLocalIsoDate(new Date()));
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  const [notesState, setNotesState] = useState<NotesState>({ scope: key, status: 'loading' });
  const work = useMemo(() => selectClientOverviewWork({
    clientId,
    projects,
    tasks,
    today,
  }), [clientId, projects, tasks, today]);

  useEffect(() => {
    let active = true;
    const subscription = liveQuery(() => records.listNotes({
      clientId,
      deleted: false,
      archived: false,
      query: '',
    })).subscribe({
      next: (result) => {
        if (!active) return;
        setNotesState(result.ok
          ? { scope: key, status: 'ready', notes: result.value }
          : { scope: key, status: 'error' });
      },
      error: () => {
        if (active) setNotesState({ scope: key, status: 'error' });
      },
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [clientId, key, records, retry]);

  const visibleNotes = notesState.scope === key && notesState.status === 'ready' ? notesState.notes : [];
  const noteSummary = selectClientOverviewNotes(visibleNotes);
  const projectsById = useMemo(() => new Map(work.projects.map((project) => [project.id, project])), [work.projects]);
  const notesStatus = notesState.scope === key ? notesState.status : 'loading';
  const portfolio = selectClientPortfolio({ clients, projects, tasks, notes: visibleNotes, today });
  const openNote = (note: ClientNote) => onOpenNote ? onOpenNote(note) : onViewNotes();
  const dateLabel = (date: string) => parseIsoDateToLocal(date)?.toLocaleDateString(i18n.language,
    { day: 'numeric', month: 'short', year: 'numeric' }) ?? date;
  const identity = clientId === null ? t('clients.everythingScope')
    : client && isNoClient(client) ? t('clients.noClientScope') : client?.name ?? t('clients.unavailableBrand');
  const noClient = clients.find(isNoClient);

  const openProject = (project: Project) => {
    useTaskStore.getState().setSelection(project.clientId, project.id);
    useUIStore.getState().setActiveTaskPage('projects');
  };
  const openTask = (task: Task, project: Project) => {
    useTaskStore.getState().setSelection(project.clientId, project.id);
    useUIStore.getState().setTaskMode(true);
    useTaskStore.getState().openTaskInActiveTab(task.id);
  };

  return <div className="clients-overview">
    <header className="ui-toolbar clients-overview-toolbar">
      <div className="clients-toolbar-identity"><h1>{t('clients.overview')}</h1><span>{identity}</span></div>
      {clientId === null && <label className="clients-directory-search"><Search aria-hidden="true" />
        <input type="search" className="ui-input" aria-label={t('clients.searchClients')} placeholder={t('clients.searchClients')}
          value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></label>}
      <div className="clients-overview-actions" role="group" aria-label={t('clients.overviewActions')}>
        {onCreateNote && (clientId === null || isLiveBrand) && <button type="button" className="ui-button clients-button" onClick={onCreateNote}>
          <Plus aria-hidden="true" />{t('clients.addNote')}</button>}
      </div>
    </header>

    <section className="clients-overview-metrics" aria-label={t('clients.workSummary')}>
      <div><strong>{work.projects.length}</strong><span>{t('clients.projectsCount')}</span></div>
      <div><strong>{work.open}</strong><span>{t('clients.openTasks')}</span></div>
      <div><strong>{work.completed}</strong><span>{t('clients.completedTasks')}</span></div>
      <div className={work.overdue ? 'clients-overdue' : undefined}><strong>{work.overdue}</strong><span>{t('clients.overdueTasks')}</span></div>
      {clientId === null && noClient && <button type="button" className="ui-button clients-link-button"
        onClick={() => useTaskStore.getState().setSelection(noClient.id, null)}>{t('clients.includesUnassigned')}<ArrowUpRight aria-hidden="true" /></button>}
    </section>

    {clientId === null && <ClientDirectory entries={portfolio} query={query} notesStatus={notesStatus}
      onSelect={(id) => useTaskStore.getState().setSelection(id, null)} />}

    <div className="clients-overview-grid">
      <div className="clients-overview-main">
        <section className="ui-card clients-overview-section" aria-label={t('clients.nextUp')}>
          <div className="clients-overview-section-heading"><h2>{t('clients.nextUp')}</h2>
            <span className="clients-muted">{t('clients.dueTodayCount', { count: work.dueToday })}</span></div>
          <p className="clients-muted">{t('clients.nextUpHint')}</p>
          {!work.prioritizedTasks.length ? <p className="clients-empty-state">{t(work.total ? 'clients.allWorkComplete' : 'clients.noTasks')}</p>
            : <ul className="clients-overview-list">
              {work.prioritizedTasks.slice(0, taskLimit).map((task) => {
                const project = projectsById.get(task.projectId);
                if (!project) return null;
                const overdue = Boolean(task.date && task.date < today);
                return <li key={task.id}><button type="button" className="ui-list-row clients-summary-row clients-task-row"
                  aria-label={t('clients.openTask', { task: task.title })} onClick={() => openTask(task, project)}>
                  <span className="clients-summary-title"><span>{task.title}</span><ArrowUpRight className="clients-row-arrow" aria-hidden="true" /></span>
                  <span className="clients-row-meta"><span>{clientId === null ? `${clients.find((entry) => entry.id === project.clientId)?.name ?? ''} / ` : ''}{project.name}</span>
                    <span>{t(task.status === 'in_progress' ? 'clients.inProgress' : 'clients.pending')}</span>
                    <span className={overdue ? 'clients-overdue' : undefined}><CalendarDays aria-hidden="true" />
                      {task.date ? <><span>{overdue ? t('clients.overdue') : task.date === today ? t('clients.dueToday') : ''}</span>
                        <time dateTime={task.date}>{dateLabel(task.date)}</time></> : t('clients.noDueDate')}</span>
                  </span>
                </button></li>;
              })}
            </ul>}
          {work.prioritizedTasks.length > taskLimit && <button type="button" className="ui-button clients-link-button"
            onClick={() => setTaskLimit((value) => value + 6)}>{t('clients.moreOpenTasks', { count: work.prioritizedTasks.length - taskLimit })}</button>}
        </section>

        <section className="ui-card clients-overview-section" aria-labelledby="clients-overview-projects-title">
          <div className="clients-overview-section-heading"><h2 id="clients-overview-projects-title">{t('clients.projects')}</h2>
            <span className="clients-muted">{t('clients.activeProjectsCount', { count: work.activeProjects })}</span></div>
          {!work.projects.length ? <p className="clients-empty-state">{t('clients.noProjects')}</p>
            : <ul className="clients-overview-list">
              {work.projectSummaries.map(({ project, open, completed, overdue, nextDueDate }) => <li key={project.id}>
                <button type="button" className="ui-list-row clients-summary-row"
                  aria-label={t('clients.openProject', { project: project.name })} onClick={() => openProject(project)}>
                  <span className="clients-summary-title"><FolderOpen aria-hidden="true" /><span>{project.name}</span><ArrowUpRight className="clients-row-arrow" aria-hidden="true" /></span>
                  <span className="clients-row-meta"><span>{t('clients.openCount', { count: open })}</span>
                    <span>{t('clients.completedCount', { count: completed })}</span>
                    {overdue > 0 && <span className="clients-overdue">{t('clients.overdueCount', { count: overdue })}</span>}
                    {nextDueDate && <span>{t('clients.nextDue', { date: dateLabel(nextDueDate) })}</span>}
                    {clientId === null && <span>{clients.find((entry) => entry.id === project.clientId)?.name}</span>}
                  </span>
                </button>
              </li>)}
            </ul>}
        </section>
      </div>

      <div className="clients-overview-aside">
        {isLiveBrand && clientId && <ClientContextSummary clientId={clientId} records={records} onProfile={onProfile} />}
        {notesStatus === 'loading' ? <p className="clients-muted" role="status">{t('clients.loading')}</p>
          : notesStatus === 'error' ? <div className="clients-action-error">
            <p className="clients-error" role="alert">{t('clients.loadFailed')}</p>
            <button type="button" className="ui-button clients-button" onClick={() => setRetry((value) => value + 1)}>{t('clients.retry')}</button>
          </div> : <>
            {clientId !== null && <section className="ui-card clients-overview-section" aria-label={t('clients.lastContact')}>
              <h2>{t('clients.lastContact')}</h2>
              {noteSummary.lastContact ? <ClientNotePreview note={noteSummary.lastContact} onOpen={openNote} />
                : <p className="clients-muted">{t('clients.noRecordedContact')}</p>}
            </section>}
            {noteSummary.pinned.length > 0 && <section className="ui-card clients-overview-section" aria-label={t('clients.pinnedNotes')}>
              <h2>{t('clients.pinnedNotes')}</h2>
              {noteSummary.pinned.map((note) => <ClientNotePreview key={note.id} note={note} onOpen={openNote}
                clientName={clientId === null ? noteDisplayName(note, clients) : undefined} />)}
            </section>}
            <section className="ui-card clients-overview-section" aria-label={t('clients.latestNotes')}>
              <div className="clients-overview-section-heading"><h2>{t('clients.latestNotes')}</h2>
                <button type="button" className="ui-button clients-link-button" onClick={onViewNotes}>{t('clients.viewAllNotes')}</button></div>
              {!noteSummary.latest.length ? <p className="clients-muted">{t('clients.noNotes')}</p>
                : noteSummary.latest.map((note) => <ClientNotePreview key={note.id} note={note} onOpen={openNote}
                  clientName={clientId === null ? noteDisplayName(note, clients) : undefined} />)}
            </section>
          </>}
      </div>
    </div>
  </div>;
}
