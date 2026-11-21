import { describe, expect, it } from 'vitest';
import type { ClientNote } from '../../types/clients';
import type { Client, Project, Task } from '../../types';
import { selectClientOverviewNotes, selectClientOverviewWork, selectClientPortfolio } from './selectors';

const projects: Project[] = [
  { id: 'project-a', name: 'A', color: '#123456', clientId: 'brand-a', createdAt: 1, order: 0 },
  { id: 'project-b', name: 'B', color: '#654321', clientId: 'brand-b', createdAt: 2, order: 0 },
  { id: 'project-general', name: 'General', color: '#777777', clientId: 'general', createdAt: 3, order: 0 },
];

const task = (id: string, projectId: string, overrides: Partial<Task> = {}): Task => ({
  id, title: id, content: '', status: 'pending', importance: 'medium', date: '2026-10-01',
  projectId, assignees: [], createdAt: 1, updatedAt: 1, order: 0, ...overrides,
});

const note = (id: string, occurredAt: number, overrides: Partial<ClientNote> = {}): ClientNote => ({
  id, clientId: 'brand-a', title: id, bodyText: '', kind: 'note', occurredAt,
  contactId: null, contactSnapshot: null, pinned: false, authorId: 'synthetic', revision: 1,
  createdAt: occurredAt, updatedAt: occurredAt, ...overrides,
});

describe('client overview selectors', () => {
  it('builds an ordered, isolated portfolio using only each real client’s live recorded contacts', () => {
    const client = (id: string, name: string, order = 0): Client => ({ id, name, order, color: '#123456', createdAt: 1 });
    const clients = [
      client('empty', 'Empty', 2), client('brand-b', 'Same'), client('brand-a', 'Same'),
      client('alphabetic', 'Alpha'), client('sentinel-1', 'NO CLIENT'), client('sentinel-2', 'General'),
    ];
    const tasks = [task('a', 'project-a'), task('b', 'project-b', { status: 'completed' })];
    const notes = [
      note('a-call', 10, { kind: 'call' }),
      note('a-meeting', 11, { kind: 'meeting' }),
      note('b-call', 20, { clientId: 'brand-b', kind: 'call' }),
      note('deleted', 30, { kind: 'call', deletedAt: 0 }),
      note('not-contact', 40, { kind: 'decision' }),
      note('detached', 50, { clientId: 'missing', kind: 'call' }),
    ];
    const input = { clients, projects, tasks, notes, today: '2026-10-05' };
    const before = structuredClone(input);
    const selected = selectClientPortfolio(input);
    expect(selected.map((item) => item.client.id)).toEqual(['alphabetic', 'brand-a', 'brand-b', 'empty']);
    expect(selected.map((item) => item.lastContact?.id ?? null)).toEqual([null, 'a-meeting', 'b-call', null]);
    expect(selected.map((item) => item.work.total)).toEqual([0, 1, 1, 0]);
    expect(selected[1].work.prioritizedTasks.map((item) => item.id)).toEqual(['a']);
    expect(selected[2].work.prioritizedTasks).toEqual([]);
    expect(selected[3].work.projectSummaries).toEqual([]);
    expect(selectClientPortfolio({ ...input, clients: [] })).toEqual([]);
    expect(selectClientPortfolio({ ...input, projects: [], tasks: [], notes: [] })
      .every((item) => item.work.total === 0 && item.lastContact === null)).toBe(true);
    expect(input).toEqual(before);
  });

  it('prioritizes only scoped open work by date, importance, order and id without mutating inputs', () => {
    const tasks = [
      task('undated', 'project-a', { date: '', importance: 'high' }),
      task('future', 'project-a', { date: '2026-10-06' }),
      task('today-low', 'project-a', { date: '2026-10-05', importance: 'low' }),
      task('today-medium', 'project-a', { date: '2026-10-05' }),
      task('today-high-z', 'project-a', { date: '2026-10-05', importance: 'high', order: 2 }),
      task('today-high-b', 'project-a', { date: '2026-10-05', importance: 'high' }),
      task('today-high-a', 'project-a', { date: '2026-10-05', importance: 'high' }),
      task('overdue', 'project-a', { date: '2026-10-02', status: 'in_progress' }),
      task('oldest', 'project-a', { date: '2026-10-01', importance: 'low' }),
      task('done', 'project-a', { status: 'completed', date: '2026-10-05' }),
      task('deleted', 'project-a', { deletedAt: 10, date: '2026-10-05' }),
      task('child', 'project-a', { parentTaskId: 'overdue', date: '2026-10-05' }),
      task('other-client', 'project-b', { date: '2026-10-05' }),
      task('orphan', 'missing'),
    ];
    const before = structuredClone(tasks);
    const work = selectClientOverviewWork({ clientId: 'brand-a', projects, tasks, today: '2026-10-05' });
    expect(work.prioritizedTasks.map((item) => item.id)).toEqual([
      'oldest', 'overdue', 'today-high-a', 'today-high-b', 'today-high-z',
      'today-medium', 'today-low', 'future', 'undated',
    ]);
    expect(work).toMatchObject({ total: 10, open: 9, completed: 1, overdue: 2, dueToday: 5 });
    expect(work.tasks).toEqual(tasks.slice(0, 10));
    expect(tasks).toEqual(before);
  });

  it('counts only live top-level tasks in the selected client scope', () => {
    const tasks = [
      task('open', 'project-a', { date: '2026-10-05' }),
      task('overdue', 'project-a', { date: '2026-10-02' }),
      task('completed', 'project-a', { status: 'completed', date: '2026-10-01' }),
      task('deleted', 'project-a', { deletedAt: 20 }),
      task('subtask', 'project-a', { parentTaskId: 'open' }),
      task('other-client', 'project-b'),
    ];

    expect(selectClientOverviewWork({ clientId: 'brand-a', projects, tasks, today: '2026-10-05' }))
      .toMatchObject({ total: 3, open: 2, completed: 1, overdue: 1, activeProjects: 1 });
    expect(selectClientOverviewWork({ clientId: 'general', projects, tasks: [task('unassigned', 'project-general')], today: '2026-10-05' }))
      .toMatchObject({ total: 1, open: 1, completed: 0, overdue: 1, activeProjects: 1 });
    expect(selectClientOverviewWork({ clientId: null, projects, tasks, today: '2026-10-05' }).total).toBe(4);
  });

  it('summarizes every scoped project including empty, completed-only and undated work', () => {
    const scopedProjects = [projects[0], ...['empty', 'done', 'undated'].map((id) => ({ ...projects[0], id })), projects[1]];
    const tasks = [
      task('today', 'project-a', { date: '2026-10-05' }),
      task('late', 'project-a', { date: '2026-10-02' }),
      task('old-done', 'project-a', { status: 'completed' }),
      task('deleted', 'project-a', { deletedAt: 1 }),
      task('child', 'project-a', { parentTaskId: 'late' }),
      task('done', 'done', { status: 'completed' }),
      task('undated', 'undated', { date: '' }),
      task('other', 'project-b'),
    ];
    const input = { clientId: 'brand-a', projects: scopedProjects, tasks, today: '2026-10-05' };
    expect(selectClientOverviewWork(input).projectSummaries).toEqual([
      { project: scopedProjects[0], total: 3, open: 2, completed: 1, overdue: 1, nextDueDate: '2026-10-02' },
      { project: scopedProjects[1], total: 0, open: 0, completed: 0, overdue: 0, nextDueDate: null },
      { project: scopedProjects[2], total: 1, open: 0, completed: 1, overdue: 0, nextDueDate: null },
      { project: scopedProjects[3], total: 1, open: 1, completed: 0, overdue: 0, nextDueDate: null },
    ]);
    expect(selectClientOverviewWork({ ...input, clientId: 'missing' })).toEqual({
      projects: [], tasks: [], prioritizedTasks: [], projectSummaries: [],
      total: 0, open: 0, completed: 0, overdue: 0, dueToday: 0, activeProjects: 0,
    });
    expect(selectClientOverviewWork({ ...input, clientId: null }).projectSummaries).toHaveLength(5);
  });

  it('returns the latest five live notes, at most five pins, and only a call or meeting as last contact', () => {
    const notes = [
      ...Array.from({ length: 7 }, (_, index) => note(`note-${index}`, index + 1, { pinned: index < 6 })),
      note('decision', 20, { kind: 'decision', pinned: true }),
      note('call', 18, { kind: 'call' }),
      note('meeting', 17, { kind: 'meeting' }),
      note('deleted', 30, { deletedAt: 31, kind: 'call' }),
    ];

    const selected = selectClientOverviewNotes(notes);
    expect(selected.latest.map((item) => item.id)).toEqual(['decision', 'call', 'meeting', 'note-6', 'note-5']);
    expect(selected.pinned).toHaveLength(5);
    expect(selected.lastContact?.id).toBe('call');
    expect(selected.latest).not.toContainEqual(expect.objectContaining({ id: 'deleted' }));
  });
});
