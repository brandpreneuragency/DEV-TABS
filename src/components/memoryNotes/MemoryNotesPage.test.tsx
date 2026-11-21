import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryNotesPage } from './MemoryNotesPage';
import { useMemoryNotesStore } from '../../stores/memoryNotesStore';
import { parseMemoryNote } from '../../services/memoryNotes/model';
import { MemoryNotesError, type MemoryNotesSnapshot } from '../../services/memoryNotes/reader';

const loader = vi.hoisted(() => vi.fn<() => Promise<MemoryNotesSnapshot>>());
vi.mock('../../services/memoryNotes/desktop', () => ({ loadMemoryNotes: loader }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  i18n: { resolvedLanguage: 'en' },
  t: (key: string, options?: { title?: string; fileName?: string }) => options?.title ? `${key}: ${options.title}` : options?.fileName ? `${key}: ${options.fileName}` : key,
}) }));

const alpha = parseMemoryNote('alpha.md', '# Alpha\n\nA searchable introduction.\n\n## Detail\n**Formatted** body.');
const beta = parseMemoryNote('beta.md', '# Beta\n\nAnother record.');

beforeEach(() => {
  useMemoryNotesStore.setState(useMemoryNotesStore.getInitialState());
  loader.mockReset().mockResolvedValue({ notes: [alpha, beta], issues: [] });
});
afterEach(cleanup);

describe('Memory Notes read-only page', () => {
  it('searches content, opens formatted detail and returns focus to its card without edit actions', async () => {
    render(<MemoryNotesPage />);
    const open = await screen.findByRole('button', { name: 'memoryNotes.open: Alpha' });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'searchable' } });
    expect(screen.queryByRole('button', { name: 'memoryNotes.open: Beta' })).toBeNull();
    open.focus(); fireEvent.click(open);
    expect(screen.getByText('Formatted').tagName).toBe('STRONG');
    expect(screen.getByRole('button', { name: 'memoryNotes.back' })).toHaveFocus();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /save|delete|new note/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'memoryNotes.back' }));
    expect(screen.getByRole('button', { name: 'memoryNotes.open: Alpha' })).toHaveFocus();
  });
  it('renders loading, empty and filter-empty as separate states', async () => {
    let complete!: (value: MemoryNotesSnapshot) => void;
    loader.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    render(<MemoryNotesPage />);
    expect(screen.getByRole('status')).toHaveTextContent('memoryNotes.loading');
    await act(async () => complete({ notes: [], issues: [] }));
    expect(screen.getByText('memoryNotes.empty')).toBeInTheDocument();
    await act(async () => { await useMemoryNotesStore.getState().load(); });
    await screen.findByRole('button', { name: 'memoryNotes.open: Alpha' });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'absent' } });
    expect(screen.getByText('memoryNotes.noResults')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'memoryNotes.clearSearch' }));
    expect(screen.getByRole('button', { name: 'memoryNotes.open: Alpha' })).toBeInTheDocument();
  });
  it('retains the previous read on refresh failure and never labels it synchronized', async () => {
    render(<MemoryNotesPage />);
    await screen.findByRole('button', { name: 'memoryNotes.open: Alpha' });
    loader.mockRejectedValueOnce(new MemoryNotesError('missing'));
    await act(async () => { await useMemoryNotesStore.getState().load(); });
    expect(await screen.findByRole('alert')).toHaveTextContent('memoryNotes.error_missing');
    expect(screen.getByText('memoryNotes.stale')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'memoryNotes.open: Alpha' })).toBeInTheDocument();
    loader.mockResolvedValueOnce({ notes: [beta], issues: [] });
    await act(async () => { await useMemoryNotesStore.getState().load(); });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByRole('button', { name: 'memoryNotes.open: Alpha' })).toBeNull();
  });
  it('shows incomplete reads instead of the ordinary empty state', async () => {
    loader.mockResolvedValueOnce({ notes: [], issues: [{ fileName: 'failed.md', reason: 'read' }] });
    render(<MemoryNotesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('memoryNotes.incomplete');
    expect(screen.queryByText('memoryNotes.empty')).toBeNull();
    expect(screen.getByText('failed.md')).toBeInTheDocument();
  });
  it('does not load remote images, active HTML or unsafe/local links', async () => {
    const untrusted = parseMemoryNote('unsafe.md', '# Unsafe\n\n![Tracking](https://example.invalid/pixel.png)\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert) [Outside](../Personal/a.md) [Web](https://example.com)');
    loader.mockResolvedValueOnce({ notes: [untrusted], issues: [] });
    const { container } = render(<MemoryNotesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'memoryNotes.open: Unsafe' }));
    expect(container.querySelector('img, script, iframe')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Bad' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Outside' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Web' })).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
