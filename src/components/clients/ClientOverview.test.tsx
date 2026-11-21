import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../../types';
import { createRecordsFixture, cleanupRecordsFixtures } from '../../services/clients/recordsTestFixtures';
import type { RecordsFixture } from '../../services/clients/recordsTestFixtures';
import { ClientOverview } from './ClientOverview';
import { useClientStore } from '../../stores/clientStore';
import { useProjectStore } from '../../stores/projectStore';
import { useTaskStore } from '../../stores/taskStore';
import { useUIStore } from '../../stores/uiStore';
import i18n from '../../i18n';

let fixture: RecordsFixture;
let project: Project;
let tasks: Task[];

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id, title: id, content: '', status: 'pending', importance: 'medium', date: '2099-01-01',
    projectId: project.id, assignees: [], createdAt: 1, updatedAt: 1, order: 0, ...overrides,
  };
}

beforeEach(async () => {
  fixture = await createRecordsFixture();
  await i18n.changeLanguage('en');
  project = { id: 'project-a', name: 'Northwind Roadmap', color: '#123456', clientId: 'client-a', createdAt: 1, order: 0 };
  await fixture.database.projects.add(project);
  tasks = [makeTask('open-task', { title: 'Prepare launch' }),
    makeTask('completed-task', { title: 'Closed work', status: 'completed' }),
    makeTask('deleted-task', { title: 'Removed work', deletedAt: 5 }),
    makeTask('child-task', { title: 'Subtask work', parentTaskId: 'open-task' })];
  useClientStore.setState({ clients: await fixture.database.clients.toArray(), isLoaded: true });
  useProjectStore.setState({ projects: [project], isLoaded: true });
  useTaskStore.setState({
    ...useTaskStore.getInitialState(), selectedClientId: 'client-a', selectedProjectId: null, tasks,
    openTabs: [{ tabId: 'empty', taskId: null, colorIndex: 0 }], activeTabId: 'empty', isLoaded: true,
  });
  useUIStore.setState({ ...useUIStore.getInitialState(), taskMode: false, crmMode: true, activeCRMPage: 'clients' });
});

afterEach(async () => {
  cleanup();
  await cleanupRecordsFixtures();
});

describe('ClientOverview', () => {
  it('reports unavailable contact history instead of inventing an empty history, then retries', async () => {
    vi.spyOn(fixture.records, 'listNotes').mockResolvedValueOnce({ ok: false, code: 'STORAGE' });
    render(<ClientOverview clientId={null} records={fixture.records} onViewNotes={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Client details could not be loaded.');
    expect(screen.getAllByText('Contact history unavailable.')).toHaveLength(2);
    expect(screen.queryByText('No call or meeting recorded.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open task: Prepare launch' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findAllByText('No call or meeting recorded.')).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps work usable when profile loading fails and retries the scoped profile separately', async () => {
    vi.spyOn(fixture.records, 'getProfile').mockResolvedValueOnce({ ok: false, code: 'STORAGE' });
    render(<ClientOverview clientId="client-a" records={fixture.records} onViewNotes={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Client details could not be loaded.');
    expect(screen.getByRole('button', { name: 'Open task: Prepare launch' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No primary contact selected.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('provides a searchable client directory with scoped workload and recorded contact', async () => {
    await fixture.records.saveNote({ id: 'call-a', clientId: 'client-a', expectedRevision: null,
      value: { title: 'Launch check-in', bodyText: 'Discussed the next release.', kind: 'call', occurredAt: 500, contactId: null },
      draftId: null, generation: null, editSessionId: null });
    useTaskStore.setState({ selectedClientId: null, selectedProjectId: null });
    render(<ClientOverview clientId={null} records={fixture.records} onViewNotes={vi.fn()} />);
    const directory = await screen.findByRole('region', { name: 'Client directory' });
    const first = within(directory).getByRole('button', { name: 'Open client: Brand A' });
    expect(first).toHaveTextContent('1 open');
    expect(await within(first).findByText('Launch check-in')).toBeInTheDocument();
    expect(within(directory).getByRole('button', { name: 'Open client: Brand B' })).toHaveTextContent('0 open');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search clients' }), { target: { value: 'Brand B' } });
    expect(within(directory).queryByRole('button', { name: 'Open client: Brand A' })).not.toBeInTheDocument();
    fireEvent.click(within(directory).getByRole('button', { name: 'Open client: Brand B' }));
    expect(useTaskStore.getState()).toMatchObject({ selectedClientId: 'client-b', selectedProjectId: null });
  });

  it('prioritizes open work, summarizes projects, and opens a note preview by exact identity', async () => {
    useTaskStore.setState({ tasks: [...tasks, makeTask('overdue', { title: 'Approve the brief', date: '2020-01-01' })] });
    const saved = await fixture.records.saveNote({ id: 'decision', clientId: 'client-a', expectedRevision: null,
      value: { title: 'Positioning decision', bodyText: 'Focus on the independent retail audience.', kind: 'decision', occurredAt: 500, contactId: null },
      draftId: null, generation: null, editSessionId: null });
    if (!saved.ok) throw new Error('Note fixture failed');
    const onOpenNote = vi.fn();
    render(<ClientOverview clientId="client-a" records={fixture.records} onViewNotes={vi.fn()} onOpenNote={onOpenNote} />);
    const attention = await screen.findByRole('region', { name: 'Next up' });
    expect(within(attention).getAllByRole('button', { name: /^Open task:/ })[0]).toHaveAccessibleName('Open task: Approve the brief');
    expect(within(attention).queryByText('Closed work')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open project: Northwind Roadmap' })).toHaveTextContent('2 open');
    const preview = await screen.findByRole('button', { name: 'Open note: Positioning decision' });
    expect(preview).toHaveTextContent('Focus on the independent retail audience.');
    fireEvent.click(preview);
    expect(onOpenNote).toHaveBeenCalledWith(expect.objectContaining({ id: 'decision', clientId: 'client-a' }));
  });

  it('surfaces saved profile and primary contact without leaking them across client switches', async () => {
    await fixture.seedContacts();
    const saved = await fixture.records.saveProfile({ clientId: 'client-a', expectedRevision: null,
      value: { website: 'https://northwind.example', description: 'Brand strategy and launch partner.' } });
    if (!saved.ok) throw new Error('Profile fixture failed');
    await fixture.database.clientProfiles.update('client-a', { primaryContactId: 'contact-a' });
    const { rerender } = render(<ClientOverview clientId="client-a" records={fixture.records} onViewNotes={vi.fn()} />);
    expect(await screen.findByText('Brand strategy and launch partner.')).toBeInTheDocument();
    expect(screen.getByText('https://northwind.example')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.test')).toBeInTheDocument();
    rerender(<ClientOverview clientId="client-b" records={fixture.records} onViewNotes={vi.fn()} />);
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    expect(screen.queryByText('Brand strategy and launch partner.')).not.toBeInTheDocument();
    expect(await screen.findByText('No primary contact selected.')).toBeInTheDocument();
    expect(await fixture.database.clientDrafts.count()).toBe(0);
  });

  it('shows real work and opens the exact project and task through existing actions', async () => {
    const onViewNotes = vi.fn();
    render(<ClientOverview clientId="client-a" records={fixture.records} onViewNotes={onViewNotes} />);

    expect(await screen.findByText('Prepare launch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open project: Northwind Roadmap' })).toBeInTheDocument();
    expect(screen.queryByText('Removed work')).not.toBeInTheDocument();
    expect(screen.queryByText('Subtask work')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Work summary' })).getAllByText('1')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Open task: Prepare launch' }));
    expect(useTaskStore.getState()).toMatchObject({ selectedClientId: 'client-a', selectedProjectId: 'project-a', activeTaskId: 'open-task' });
    expect(useUIStore.getState().taskMode).toBe(true);
    expect(await screen.findByText('No notes found.')).toBeInTheDocument();

    act(() => {
      useUIStore.getState().setTaskMode(false);
      useUIStore.getState().setActiveTaskPage('list');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open project: Northwind Roadmap' }));
    expect(useTaskStore.getState()).toMatchObject({ selectedClientId: 'client-a', selectedProjectId: 'project-a' });
    expect(useUIStore.getState()).toMatchObject({ crmMode: true, activeCRMPage: 'projects' });
    fireEvent.click(screen.getAllByRole('button', { name: 'View all notes' })[0]);
    expect(onViewNotes).toHaveBeenCalledOnce();
  });

  it('shows actual latest notes, pinned notes, and last call or meeting', async () => {
    const noteInput = (id: string, kind: 'call' | 'meeting' | 'decision' | 'note', occurredAt: number, pinned = false) =>
      fixture.records.saveNote({ id, clientId: 'client-a', expectedRevision: null,
        value: { title: id, bodyText: 'Synthetic content', kind, occurredAt, contactId: null },
        draftId: null, generation: null, editSessionId: null }).then(async (result) => {
          if (!result.ok) throw new Error(`Could not seed ${id}`);
          if (pinned) await fixture.records.setNotePinned({ id, clientId: 'client-a', expectedRevision: result.value.revision, pinned: true });
        });
    await Promise.all([
      noteInput('decision-note', 'decision', 500, true),
      noteInput('call-note', 'call', 400),
      noteInput('meeting-note', 'meeting', 300),
    ]);

    render(<ClientOverview clientId="client-a" records={fixture.records} onViewNotes={vi.fn()} />);
    expect(await screen.findAllByText('decision-note')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Last call or meeting' })).toHaveTextContent('call-note');
  });

  it('shows and routes real No Client work without adding brand-only actions', async () => {
    const generalProject: Project = {
      id: 'project-general', name: 'Unassigned project', color: '#654321', clientId: 'general', createdAt: 2, order: 0,
    };
    const generalTask = makeTask('general-task', { projectId: generalProject.id, title: 'Unassigned follow-up' });
    await fixture.database.projects.add(generalProject);
    useProjectStore.setState({ projects: [project, generalProject], isLoaded: true });
    useTaskStore.setState({ ...useTaskStore.getState(), selectedClientId: 'general', tasks: [...tasks, generalTask] });

    render(<ClientOverview clientId="general" records={fixture.records} onViewNotes={vi.fn()}
      onCreateNote={vi.fn()} onProfile={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Open project: Unassigned project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open task: Unassigned follow-up' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Profile' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open task: Unassigned follow-up' }));
    expect(useTaskStore.getState()).toMatchObject({
      selectedClientId: 'general', selectedProjectId: 'project-general', activeTaskId: 'general-task',
    });
  });
});
