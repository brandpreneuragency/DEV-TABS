// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createMemoryCollectionStore, createMemoryNotesStore } from './memoryNotesStore';
import { parseMemoryNote } from '../services/memoryNotes/model';

const resource = { ...parseMemoryNote('Tools/shared.md', '# Resource'), category: 'Tools', sourceUrl: 'https://example.invalid/tool' };

describe('independent Memory collection snapshots', () => {
  it('keeps a late Resources read and selection separate from Notes with the same basename', async () => {
    let finish!: (value: { notes: typeof resource[]; issues: [] }) => void;
    const resources = createMemoryCollectionStore(() => new Promise<{ notes: typeof resource[]; issues: [] }>((resolve) => { finish = resolve; }));
    const notes = createMemoryNotesStore(async () => ({ notes: [parseMemoryNote('shared.md', '# Note')], issues: [] }));
    const pending = resources.getState().load();
    await notes.getState().load();
    notes.getState().select('shared.md');
    finish({ notes: [resource], issues: [] });
    await pending;
    resources.getState().select('Tools/shared.md');
    expect(notes.getState().notes[0].title).toBe('Note');
    expect(notes.getState().selectedFileName).toBe('shared.md');
    expect(resources.getState().notes[0].category).toBe('Tools');
    expect(resources.getState().notes[0].sourceUrl).toBe('https://example.invalid/tool');
    expect(resources.getState().selectedFileName).toBe('Tools/shared.md');
  });
});
