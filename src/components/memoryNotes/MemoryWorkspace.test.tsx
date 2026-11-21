import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryWorkspace } from './MemoryWorkspace';
import { MemoryNotesNavigation } from './MemoryNotesNavigation';
import { useMemoryNavigationStore } from '../../stores/memoryNavigationStore';
import { useMemoryNotesStore } from '../../stores/memoryNotesStore';
import { useMemoryResourcesStore } from '../../stores/memoryResourcesStore';
import { useMemoryToReadStore } from '../../stores/memoryToReadStore';
import { useMemorySomedayStore } from '../../stores/memorySomedayStore';
import { parseMemoryNote } from '../../services/memoryNotes/model';
import { MemoryNotesError, type MemoryNotesSnapshot } from '../../services/memoryNotes/reader';
import { isTauriRuntime } from '../../services/runtime';

const loaders = vi.hoisted(() => ({ notes: vi.fn(), resources: vi.fn(), toRead: vi.fn(), someday: vi.fn() }));
vi.mock('../../services/runtime', () => ({ isTauriRuntime: vi.fn() }));
vi.mock('../../services/memoryNotes/desktop', () => ({ loadMemoryNotes: loaders.notes }));
vi.mock('../../services/memoryResources/desktop', () => ({ loadMemoryResources: loaders.resources }));
vi.mock('../../services/memoryToRead/desktop', () => ({ loadMemoryToRead: loaders.toRead }));
vi.mock('../../services/memorySomeday/desktop', () => ({ loadMemorySomeday: loaders.someday }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { resolvedLanguage: 'en' },
  t: (key: string, options?: { title?: string }) => options?.title ? `${key}: ${options.title}` : key,
}) }));
const note = parseMemoryNote('shared.md', '# Personal note');
const resource = { ...parseMemoryNote('Tools/shared.md', '# Tool reference'), category: 'Tools', sourceUrl: 'https://example.invalid/tool' };

beforeEach(() => {
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  useMemoryNavigationStore.setState(useMemoryNavigationStore.getInitialState());
  useMemoryNotesStore.setState(useMemoryNotesStore.getInitialState());
  useMemoryResourcesStore.setState(useMemoryResourcesStore.getInitialState());
  useMemoryToReadStore.setState(useMemoryToReadStore.getInitialState());
  useMemorySomedayStore.setState(useMemorySomedayStore.getInitialState());
  loaders.notes.mockReset().mockResolvedValue({ notes: [note], issues: [] });
  loaders.resources.mockReset().mockResolvedValue({ notes: [resource], issues: [] });
  loaders.toRead.mockReset().mockResolvedValue({ notes: [], issues: [] });
  loaders.someday.mockReset().mockResolvedValue({ notes: [], issues: [] });
});
afterEach(cleanup);

describe('Memory collection navigation', () => {
  it('disables manual refresh in the browser preview', () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false);
    useMemoryResourcesStore.setState({ error: 'unsupported' });
    render(<MemoryNotesNavigation />);
    const refresh = screen.getByRole('button', { name: 'memoryNotes.refreshAllLabel' });
    expect(refresh).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(refresh);
    for (const loader of Object.values(loaders)) expect(loader).not.toHaveBeenCalled();
  });

  it('starts with Notes, reads Resources only on demand and isolates late results after switching back', async () => {
    let finish!: (value: MemoryNotesSnapshot<typeof resource>) => void;
    loaders.resources.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<><MemoryNotesNavigation /><MemoryWorkspace /></>);
    await screen.findByRole('button', { name: 'memoryNotes.open: Personal note' });
    expect(loaders.resources).not.toHaveBeenCalled();
    const notesTab = screen.getByRole('button', { name: 'memoryNotes.notes' });
    const resourcesTab = screen.getByRole('button', { name: 'memoryResources.resources' });
    expect(notesTab).toHaveAttribute('aria-current', 'page');
    fireEvent.click(resourcesTab);
    expect(resourcesTab).toHaveAttribute('aria-current', 'page');
    expect(notesTab).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('status')).toHaveTextContent('memoryResources.loading');
    expect(screen.queryByRole('button', { name: 'memoryNotes.open: Personal note' })).toBeNull();
    fireEvent.click(notesTab);
    await screen.findByRole('button', { name: 'memoryNotes.open: Personal note' });
    await act(async () => finish({ notes: [resource], issues: [] }));
    expect(screen.queryByRole('button', { name: 'memoryResources.open: Tool reference' })).toBeNull();
    expect(useMemoryNotesStore.getState().notes).toEqual([note]);
    fireEvent.click(resourcesTab);
    fireEvent.click(await screen.findByRole('button', { name: 'memoryResources.open: Tool reference' }));
    expect(screen.getByRole('article', { name: 'Tool reference' })).toBeInTheDocument();
    expect(screen.getByText('Tools/shared.md')).toBeInTheDocument();
    fireEvent.click(resourcesTab);
    expect(screen.getByRole('button', { name: 'memoryResources.open: Tool reference' })).toBeInTheDocument();
  });

  it('refreshes all four collections from the navigation while preserving the open item', async () => {
    let finishSomeday!: (value: MemoryNotesSnapshot) => void;
    loaders.someday.mockImplementationOnce(() => new Promise((resolve) => { finishSomeday = resolve; }));
    render(<><MemoryNotesNavigation /><MemoryWorkspace /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'memoryNotes.open: Personal note' }));

    const refresh = screen.getByRole('button', { name: 'memoryNotes.refreshAllLabel' });
    expect(refresh.closest('.nav-bar-header')?.nextElementSibling).toHaveClass('memory-scope-tabs');
    expect(screen.queryByRole('button', { name: 'navigation.providerAccounts' })).not.toBeInTheDocument();
    fireEvent.click(refresh);
    expect(refresh).toBeDisabled();
    expect(loaders.notes).toHaveBeenCalledTimes(2);
    expect(loaders.resources).toHaveBeenCalledTimes(1);
    expect(loaders.toRead).toHaveBeenCalledTimes(1);
    expect(loaders.someday).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useMemoryResourcesStore.getState().notes).toEqual([resource]));
    expect(useMemoryToReadStore.getState().hasSnapshot).toBe(true);
    expect(useMemoryNavigationStore.getState().page).toBe('notes');
    expect(screen.getByRole('article', { name: 'Personal note' })).toBeInTheDocument();

    await act(async () => finishSomeday({ notes: [], issues: [] }));
    expect(refresh).toBeEnabled();
    expect(useMemorySomedayStore.getState().hasSnapshot).toBe(true);
  });

  it('keeps the last resource snapshot when its refresh fails while other collections succeed', async () => {
    useMemoryResourcesStore.setState({ notes: [resource], hasSnapshot: true });
    loaders.resources.mockRejectedValueOnce(new MemoryNotesError('read'));
    render(<><MemoryNotesNavigation /><MemoryWorkspace /></>);
    await screen.findByRole('button', { name: 'memoryNotes.open: Personal note' });
    fireEvent.click(screen.getByRole('button', { name: 'memoryNotes.refreshAllLabel' }));

    await waitFor(() => expect(useMemoryResourcesStore.getState().error).toBe('read'));
    expect(useMemoryResourcesStore.getState().notes).toEqual([resource]);
    expect(useMemoryToReadStore.getState().hasSnapshot).toBe(true);
    expect(useMemorySomedayStore.getState().hasSnapshot).toBe(true);
    expect(await screen.findByRole('alert')).toHaveTextContent('memoryNotes.refreshFailed: memoryResources.resources');
  });
});
