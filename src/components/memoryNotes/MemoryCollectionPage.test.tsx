import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryCollectionStore } from '../../stores/memoryNotesStore';
import { parseMemoryNote } from '../../services/memoryNotes/model';
import { MemoryNotesError } from '../../services/memoryNotes/reader';
import { MemoryCollectionPage } from './MemoryCollectionPage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  i18n: { resolvedLanguage: 'en' }, t: (key: string, options?: { title?: string }) => options?.title ? `${key}: ${options.title}` : key,
}) }));
afterEach(cleanup);

const resources = [
  { ...parseMemoryNote('Tools/shared.md', '# Alpha\n\nNeedle **formatted** details.'), category: 'Tools', sourceUrl: 'https://example.invalid/alpha?q=1#docs' },
  { ...parseMemoryNote('Agent-Skills/shared.md', '# Beta\n\nNeedle too.'), category: 'Agent-Skills', sourceUrl: null },
  { ...parseMemoryNote('plain.md', '# Root'), category: null, sourceUrl: 'javascript:alert(1)' },
];
describe('shared Memory Resources cards', () => {
  it('combines folder categories with search, keeps exact source links separate from the card action and opens the correct relative path', async () => {
    const store = createMemoryCollectionStore(async () => ({ notes: resources, issues: [] }));
    render(<MemoryCollectionPage store={store} translationKey="memoryResources" withCategories />);
    const card = await screen.findByRole('button', { name: 'memoryResources.open: Alpha' });
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(screen.getByRole('link', { name: 'memoryResources.source: Alpha' })).toHaveAttribute('href', 'https://example.invalid/alpha?q=1#docs');
    expect(card.querySelector('a')).toBeNull();
    expect(screen.queryByRole('link', { name: 'memoryResources.source: Root' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'memoryResources.category' }), { target: { value: 'Tools' } });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'needle' } });
    expect(screen.queryByRole('button', { name: 'memoryResources.open: Beta' })).toBeNull();
    fireEvent.click(card);
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(store.getState().selectedFileName).toBe('Tools/shared.md');
    expect(screen.getByText('formatted').tagName).toBe('STRONG');
    expect(screen.getByRole('button', { name: 'memoryResources.back' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'memoryResources.back' }));
    expect(screen.getByRole('button', { name: 'memoryResources.open: Alpha' })).toHaveFocus();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'absent' } });
    expect(screen.getByText('memoryResources.noResults')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'memoryResources.clearSearch' }));
    expect(screen.getByRole('button', { name: 'memoryResources.open: Beta' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save|delete|new resource/i })).toBeNull();
  });

  it('retains stale resources after a failed refresh and clears the opened path after confirmed removal', async () => {
    const loader = vi.fn().mockResolvedValueOnce({ notes: resources, issues: [] })
      .mockRejectedValueOnce(new MemoryNotesError('read')).mockResolvedValueOnce({ notes: [], issues: [] });
    const store = createMemoryCollectionStore<(typeof resources)[number]>(loader);
    render(<MemoryCollectionPage store={store} translationKey="memoryResources" withCategories />);
    fireEvent.click(await screen.findByRole('button', { name: 'memoryResources.open: Alpha' }));
    await act(async () => { await store.getState().load(); });
    expect(await screen.findByRole('alert')).toHaveTextContent('memoryResources.error_read');
    expect(screen.getByText('memoryResources.stale')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Alpha' })).toBeInTheDocument();
    await act(async () => { await store.getState().load(); });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(store.getState().selectedFileName).toBeNull();
    expect(screen.getByText('memoryResources.empty')).toBeInTheDocument();
  });
});
