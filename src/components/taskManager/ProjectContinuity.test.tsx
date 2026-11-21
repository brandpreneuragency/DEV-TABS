import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '../../i18n';
import { ProjectContinuityBody } from './ProjectContinuity';
import { ContinuityRepository } from '../../services/projectContinuity';
import * as fs from '../../services/fs-adapter';
import { META_KEY } from '../../services/taskAuthority/model';
vi.mock('../../services/runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('../../services/fs-adapter', () => ({ openFileDialog: vi.fn(), getMetadata: vi.fn(), readTextFile: vi.fn() }));
let database: Dexie;
let repo: ContinuityRepository;
const path = 'C:/fixture/docs/work/continuity.md';
beforeEach(async () => {
  vi.resetAllMocks();
  database = new Dexie(`continuity-ui-${crypto.randomUUID()}`);
  database.version(1).stores({ settings: 'key', projects: 'id', tasks: 'id' });
  await database.table('projects').bulkPut([{ id: 'a', createdAt: 1, name: 'Same' }, { id: 'b', createdAt: 2, name: 'Same' }]);
  await database.table('tasks').put({ id: 'task', projectId: 'a', status: 'pending' });
  repo = new ContinuityRepository(database);
  vi.mocked(fs.openFileDialog).mockResolvedValue(path);
  vi.mocked(fs.getMetadata).mockResolvedValue({ size: 50, modifiedAt: new Date(1000), isFile: true, isDirectory: false });
  vi.mocked(fs.readTextFile).mockResolvedValue('# Handoff\nNext: owner trial\n<script>not executed</script>');
});
afterEach(async () => { cleanup(); await database.delete(); });

it('selects, persists, reopens and reads a work record as inert text without task writes', async () => {
  const original = await database.table('tasks').toArray();
  const view = render(<ProjectContinuityBody projectId="a" repo={repo} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Select reference' })[1]).toBeEnabled());
  fireEvent.click(screen.getAllByRole('button', { name: 'Select reference' })[1]);
  await screen.findByText(path);
  expect(fs.readTextFile).not.toHaveBeenCalled();
  view.unmount();
  render(<ProjectContinuityBody projectId="a" repo={new ContinuityRepository(database)} />);
  await screen.findByText(path);
  fireEvent.click(screen.getAllByRole('button', { name: 'Reselect file and read' })[1]);
  await screen.findByText(/Next: owner trial/);
  expect(document.querySelector('script')).toBeNull();
  expect(screen.getByText(/snapshot only; may already be stale/)).toBeInTheDocument();
  expect(await database.table('tasks').toArray()).toEqual(original);
  expect((await repo.load('b')).references).toEqual({});
  vi.mocked(fs.getMetadata).mockRejectedValueOnce(new Error('missing file'));
  fireEvent.click(screen.getAllByRole('button', { name: 'Reselect file and read' })[1]);
  await screen.findByRole('alert');
  expect(screen.queryByText(/Next: owner trial/)).not.toBeInTheDocument();
});

it('does not attach an in-flight picker selection to a new project after unmount', async () => {
  let finish!: (path: string) => void;
  vi.mocked(fs.openFileDialog).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<ProjectContinuityBody projectId="a" repo={repo} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Select reference' })[0]).toBeEnabled());
  fireEvent.click(screen.getAllByRole('button', { name: 'Select reference' })[0]);
  view.unmount();
  render(<ProjectContinuityBody projectId="b" repo={repo} />);
  finish(path);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Select reference' })[0]).toBeEnabled());
  expect((await repo.load('a')).references).toEqual({});
  expect((await repo.load('b')).references).toEqual({});
  expect(screen.queryByText(path)).not.toBeInTheDocument();
});

async function switchAuthority() {
  await act(async () => {
    await database.table('settings').put({ key: META_KEY, value: {
      schema: 1, phase: 'active', actor: 'fixture', databaseId: 'new-authority',
      generation: 1, baseline: [], conflicts: [], deletions: [],
    } });
  });
}

it('clears an open reference and snapshot when authority changes with the same project id', async () => {
  await repo.save(await repo.load('a'), { workRecord: path });
  render(<ProjectContinuityBody projectId="a" repo={repo} />);
  await screen.findByText(path);
  fireEvent.click(screen.getAllByRole('button', { name: 'Reselect file and read' })[1]);
  await screen.findByText(/Next: owner trial/);
  await switchAuthority();
  expect((await repo.load('a')).references).toEqual({});
  await waitFor(() => expect(screen.queryByText(path)).not.toBeInTheDocument());
  expect(screen.queryByText(/Next: owner trial/)).not.toBeInTheDocument();
});

it('invalidates a pending picker on authority change without writing either identity', async () => {
  let finish!: (value: string) => void;
  vi.mocked(fs.openFileDialog).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const original = await repo.load('a');
  render(<ProjectContinuityBody projectId="a" repo={repo} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Select reference' })[0]).toBeEnabled());
  fireEvent.click(screen.getAllByRole('button', { name: 'Select reference' })[0]);
  await switchAuthority();
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Select reference' })[0]).toBeEnabled());
  await act(async () => { finish(path); });
  expect((await repo.load('a')).references).toEqual({});
  expect(await database.table('settings').get(`projectContinuityV1:${original.identity}`)).toBeUndefined();
  expect(screen.queryByText(path)).not.toBeInTheDocument();
});

it('discards an in-flight file read after an authority change', async () => {
  await repo.save(await repo.load('a'), { workRecord: path });
  let finish!: (value: string) => void;
  vi.mocked(fs.readTextFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ProjectContinuityBody projectId="a" repo={repo} />);
  await screen.findByText(path);
  fireEvent.click(screen.getAllByRole('button', { name: 'Reselect file and read' })[1]);
  await waitFor(() => expect(fs.readTextFile).toHaveBeenCalled());
  await switchAuthority();
  await waitFor(() => expect(screen.queryByText(path)).not.toBeInTheDocument());
  await act(async () => { finish('old authority preview'); });
  expect(screen.queryByText('old authority preview')).not.toBeInTheDocument();
});

it('does not publish a pending initial load from the previous authority', async () => {
  await repo.save(await repo.load('a'), { workRecord: path });
  const load = repo.load.bind(repo);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const spy = vi.spyOn(repo, 'load').mockImplementationOnce(async projectId => {
    const value = await load(projectId);
    await pending;
    return value;
  });
  render(<ProjectContinuityBody projectId="a" repo={repo} />);
  await waitFor(() => expect(spy).toHaveBeenCalled());
  await switchAuthority();
  await act(async () => { finish(); });
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Select reference' })[0]).toBeEnabled());
  expect(screen.queryByText(path)).not.toBeInTheDocument();
});

it('recovers after unavailable authority without restoring the previous snapshot', async () => {
  await repo.save(await repo.load('a'), { workRecord: path });
  render(<ProjectContinuityBody projectId="a" repo={repo} />);
  await screen.findByText(path);
  fireEvent.click(screen.getAllByRole('button', { name: 'Reselect file and read' })[1]);
  await screen.findByText(/Next: owner trial/);
  await act(async () => { await database.table('settings').put({ key: META_KEY, value: { schema: 999 } }); });
  await screen.findByRole('alert');
  expect(screen.queryByText(path)).not.toBeInTheDocument();
  expect(screen.queryByText(/Next: owner trial/)).not.toBeInTheDocument();
  await switchAuthority();
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(screen.getAllByRole('button', { name: 'Select reference' })[0]).toBeEnabled();
});

it('does not revive a pending selection when authority changes away and back', async () => {
  let finish!: (value: string) => void;
  vi.mocked(fs.openFileDialog).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ProjectContinuityBody projectId="a" repo={repo} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Select reference' })[0]).toBeEnabled());
  fireEvent.click(screen.getAllByRole('button', { name: 'Select reference' })[0]);
  await switchAuthority();
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Select reference' })[0]).toBeEnabled());
  await act(async () => { await database.table('settings').delete(META_KEY); });
  await act(async () => { finish(path); });
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Select reference' })[0]).toBeEnabled());
  expect((await repo.load('a')).references).toEqual({});
  expect(screen.queryByText(path)).not.toBeInTheDocument();
});
