import { create } from 'zustand';
import { loadMemoryNotes } from '../services/memoryNotes/desktop';
import type { MemoryNote } from '../services/memoryNotes/model';
import { MemoryNotesError, type MemoryNotesSnapshot } from '../services/memoryNotes/reader';

export interface MemoryNotesStore<T extends MemoryNote = MemoryNote> extends MemoryNotesSnapshot<T> {
  loading: boolean;
  hasSnapshot: boolean;
  error: MemoryNotesError['code'] | null;
  selectedFileName: string | null;
  load(): Promise<void>;
  select(fileName: string | null): void;
}

/** Memory-only view state. Owner records and Quick Notes storage are never written. */
export function createMemoryCollectionStore<T extends MemoryNote>(loader: () => Promise<MemoryNotesSnapshot<T>>) {
  let inFlight: Promise<void> | null = null;
  return create<MemoryNotesStore<T>>((set, get) => ({
    notes: [], issues: [], loading: false, hasSnapshot: false, error: null, selectedFileName: null,
    select: (selectedFileName) => set({ selectedFileName }),
    load: () => {
      if (inFlight) return inFlight;
      set({ loading: true });
      inFlight = (async () => {
        try {
          const snapshot = await loader();
          const selected = get().selectedFileName;
          set({ ...snapshot, hasSnapshot: true, error: null,
            selectedFileName: snapshot.notes.some((note) => note.fileName === selected) ? selected : null });
        } catch (error) {
          // Keep old content explicitly stale; read failure is not deletion or an empty collection.
          set({ error: error instanceof MemoryNotesError ? error.code : 'read' });
        } finally {
          set({ loading: false });
          inFlight = null;
        }
      })();
      return inFlight;
    },
  }));
}

export function createMemoryNotesStore(loader = loadMemoryNotes) {
  return createMemoryCollectionStore(loader);
}

export const useMemoryNotesStore = createMemoryNotesStore();
