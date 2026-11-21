import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryWorkspace } from '../memoryNotes/MemoryWorkspace';
import { MemoryNotesNavigation } from '../memoryNotes/MemoryNotesNavigation';
import { useMemoryNavigationStore } from '../../stores/memoryNavigationStore';
import { useMemoryNotesStore } from '../../stores/memoryNotesStore';
import { useMemoryResourcesStore } from '../../stores/memoryResourcesStore';
import { useMemoryToReadStore } from '../../stores/memoryToReadStore';
import { parseMemoryToRead } from '../../services/memoryToRead/model';
import { parseMemoryNote } from '../../services/memoryNotes/model';
import { MemoryNotesError } from '../../services/memoryNotes/reader';
import type { MemoryToReadSnapshot } from '../../services/memoryToRead/reader';

const loaders = vi.hoisted(() => ({ notes: vi.fn(), resources: vi.fn(), toRead: vi.fn() }));
vi.mock('../../services/runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('../../services/memoryNotes/desktop', () => ({ loadMemoryNotes: loaders.notes }));
vi.mock('../../services/memoryResources/desktop', () => ({ loadMemoryResources: loaders.resources }));
vi.mock('../../services/memoryToRead/desktop', () => ({ loadMemoryToRead: loaders.toRead }));
vi.mock('../../services/memorySomeday/desktop', () => ({ loadMemorySomeday: async () => ({ notes: [], issues: [] }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { resolvedLanguage: 'en' },
  t: (key: string, options?: { title?: string }) => options?.title ? `${key}: ${options.title}` : key,
}) }));
const reading = parseMemoryToRead('same.md', '---\ntitle: "Saved article"\nstatus: review\nsource: "https://example.invalid/article?x=1#part"\n---\n## Kısaca\n\nSearchable introduction.\n\n**Full** reading note.');
const note = parseMemoryNote('same.md', '# Plain note');
const resource = { ...parseMemoryNote('Tools/same.md', '# Tool'), category: 'Tools', sourceUrl: null };
beforeEach(() => {
  useMemoryNotesStore.setState(useMemoryNotesStore.getInitialState());
  useMemoryResourcesStore.setState(useMemoryResourcesStore.getInitialState());
  useMemoryToReadStore.setState(useMemoryToReadStore.getInitialState());
  useMemoryNavigationStore.setState(useMemoryNavigationStore.getInitialState());
  loaders.notes.mockReset().mockResolvedValue({ notes: [note], issues: [] });
  loaders.resources.mockReset().mockResolvedValue({ notes: [resource], issues: [] });
  loaders.toRead.mockReset().mockResolvedValue({ notes: [reading], issues: [] });
});
afterEach(cleanup);

function mount() { render(<><MemoryNotesNavigation /><MemoryWorkspace /></>); }

describe('To-Read workspace', () => {
  it('loads on demand, searches and opens source/detail without categories, read-status writes or reminder actions', async () => {
    mount();
    await screen.findByRole('button', { name: 'memoryNotes.open: Plain note' });
    expect(loaders.toRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'memoryToRead.toRead' }));
    const open = await screen.findByRole('button', { name: 'memoryToRead.open: Saved article' });
    expect(screen.getByRole('button', { name: 'memoryToRead.toRead' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'memoryToRead.source: Saved article' })).toHaveAttribute('href', 'https://example.invalid/article?x=1#part');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'searchable' } });
    fireEvent.click(open);
    expect(screen.getByText('Full').tagName).toBe('STRONG');
    expect(useMemoryToReadStore.getState().selectedFileName).toBe('same.md');
    expect(useMemoryToReadStore.getState().notes).toEqual([reading]);
    expect(screen.queryByRole('button', { name: /mark|delete|save|reminder/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'memoryToRead.back' }));
    expect(screen.getByRole('button', { name: 'memoryToRead.open: Saved article' })).toHaveFocus();
  });
  it('keeps a late To-Read result isolated after switching to Resources with a colliding filename', async () => {
    let finish!: (snapshot: MemoryToReadSnapshot) => void;
    loaders.toRead.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    await screen.findByRole('button', { name: 'memoryNotes.open: Plain note' });
    fireEvent.click(screen.getByRole('button', { name: 'memoryToRead.toRead' }));
    expect(screen.getByRole('status')).toHaveTextContent('memoryToRead.loading');
    fireEvent.click(screen.getByRole('button', { name: 'memoryResources.resources' }));
    await screen.findByRole('button', { name: 'memoryResources.open: Tool' });
    await act(async () => finish({ notes: [reading], issues: [] }));
    expect(screen.queryByRole('button', { name: 'memoryToRead.open: Saved article' })).toBeNull();
    expect(useMemoryResourcesStore.getState().notes).toEqual([resource]);
    expect(useMemoryNotesStore.getState().notes).toEqual([note]);
  });
  it('shows a failed-refresh warning with the last known reading list', async () => {
    useMemoryNavigationStore.setState({ page: 'toRead' });
    mount();
    await screen.findByRole('button', { name: 'memoryToRead.open: Saved article' });
    loaders.toRead.mockRejectedValueOnce(new MemoryNotesError('missing'));
    fireEvent.click(screen.getByRole('button', { name: 'memoryNotes.refreshAllLabel' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('memoryToRead.error_missing');
    expect(screen.getByText('memoryToRead.stale')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'memoryToRead.open: Saved article' })).toBeInTheDocument();
  });
});
