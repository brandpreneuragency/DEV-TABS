// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createMemoryNotesStore } from './memoryNotesStore';
import { parseMemoryNote } from '../services/memoryNotes/model';
import { MemoryNotesError, type MemoryNotesSnapshot } from '../services/memoryNotes/reader';

const note = parseMemoryNote('note.md', '# Original');

describe('Memory Notes snapshot lifecycle', () => {
  it('keeps the last snapshot visibly stale on a failed refresh and recovers on retry', async () => {
    const loader = vi.fn<() => Promise<MemoryNotesSnapshot>>()
      .mockResolvedValueOnce({ notes: [note], issues: [] })
      .mockRejectedValueOnce(new MemoryNotesError('missing'))
      .mockResolvedValueOnce({ notes: [], issues: [] });
    const store = createMemoryNotesStore(loader);
    await store.getState().load();
    store.getState().select(note.fileName);
    await store.getState().load();
    expect(store.getState()).toMatchObject({ notes: [note], error: 'missing', selectedFileName: 'note.md', hasSnapshot: true });
    await store.getState().load();
    expect(store.getState()).toMatchObject({ notes: [], error: null, selectedFileName: null, hasSnapshot: true });
  });
  it('coalesces duplicate refreshes and never converts a pending result to empty success', async () => {
    let resolve!: (value: MemoryNotesSnapshot) => void;
    const loader = vi.fn(() => new Promise<MemoryNotesSnapshot>((done) => { resolve = done; }));
    const store = createMemoryNotesStore(loader);
    const first = store.getState().load();
    const second = store.getState().load();
    expect(loader).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({ loading: true, hasSnapshot: false });
    resolve({ notes: [note], issues: [] });
    await Promise.all([first, second]);
    expect(store.getState()).toMatchObject({ notes: [note], loading: false, error: null });
  });
});
