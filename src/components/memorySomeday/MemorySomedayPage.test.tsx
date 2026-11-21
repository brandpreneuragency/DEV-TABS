import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryWorkspace } from '../memoryNotes/MemoryWorkspace';
import { MemoryNotesNavigation } from '../memoryNotes/MemoryNotesNavigation';
import { useMemoryNavigationStore } from '../../stores/memoryNavigationStore';
import { useMemoryNotesStore } from '../../stores/memoryNotesStore';
import { useMemorySomedayStore } from '../../stores/memorySomedayStore';
import { parseMemoryToRead } from '../../services/memoryToRead/model';
import { parseMemoryNote } from '../../services/memoryNotes/model';
import type { MemorySomedaySnapshot } from '../../services/memorySomeday/reader';
import { MemoryNotesError } from '../../services/memoryNotes/reader';

const loaders = vi.hoisted(() => ({ notes: vi.fn(), someday: vi.fn() }));
vi.mock('../../services/memoryNotes/desktop', () => ({ loadMemoryNotes: loaders.notes }));
vi.mock('../../services/memorySomeday/desktop', () => ({ loadMemorySomeday: loaders.someday }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { resolvedLanguage: 'en' },
  t: (key: string, options?: { title?: string }) => options?.title ? `${key}: ${options.title}` : key,
}) }));
const idea = parseMemoryToRead('Idea/idea.md', '# Future idea\n\nSearchable idea.\n\n**Details** stay here.');
const note = parseMemoryNote('same.md', '# Plain note');
beforeEach(() => {
  useMemoryNotesStore.setState(useMemoryNotesStore.getInitialState());
  useMemorySomedayStore.setState(useMemorySomedayStore.getInitialState());
  useMemoryNavigationStore.setState(useMemoryNavigationStore.getInitialState());
  loaders.notes.mockReset().mockResolvedValue({ notes: [note], issues: [] });
  loaders.someday.mockReset().mockResolvedValue({ notes: [idea], issues: [] });
});
afterEach(cleanup);
function mount() { render(<><MemoryNotesNavigation /><MemoryWorkspace /></>); }

describe('Someday workspace', () => {
  it('loads only when selected, searches and opens an idea without task or reminder actions', async () => {
    mount();
    await screen.findByRole('button', { name: 'memoryNotes.open: Plain note' });
    expect(loaders.someday).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'memorySomeday.someday' }));
    const open = await screen.findByRole('button', { name: 'memorySomeday.open: Future idea' });
    expect(screen.getByRole('button', { name: 'memorySomeday.someday' })).toHaveAttribute('aria-current', 'page');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'searchable' } });
    fireEvent.click(open);
    expect(screen.getByText('Details').tagName).toBe('STRONG');
    expect(useMemorySomedayStore.getState().selectedFileName).toBe('Idea/idea.md');
    expect(screen.queryByRole('button', { name: /task|reminder|delete|save/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'memorySomeday.back' }));
    expect(screen.getByRole('button', { name: 'memorySomeday.open: Future idea' })).toHaveFocus();
  });
  it('isolates late results and retains stale data on a failed refresh', async () => {
    let finish!: (snapshot: MemorySomedaySnapshot) => void;
    loaders.someday.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    await screen.findByRole('button', { name: 'memoryNotes.open: Plain note' });
    fireEvent.click(screen.getByRole('button', { name: 'memorySomeday.someday' }));
    fireEvent.click(screen.getByRole('button', { name: 'memoryNotes.notes' }));
    await act(async () => finish({ notes: [idea], issues: [] }));
    expect(useMemoryNotesStore.getState().notes).toEqual([note]);
    expect(screen.queryByRole('button', { name: 'memorySomeday.open: Future idea' })).toBeNull();
    loaders.someday.mockRejectedValueOnce(new MemoryNotesError('missing'));
    fireEvent.click(screen.getByRole('button', { name: 'memorySomeday.someday' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('memorySomeday.error_missing');
    expect(screen.getByText('memorySomeday.stale')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'memorySomeday.open: Future idea' })).toBeInTheDocument();
  });
});
