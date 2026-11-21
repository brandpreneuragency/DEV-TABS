import { create } from 'zustand';

type MemoryPage = 'notes' | 'resources' | 'toRead' | 'someday';
interface MemoryNavigationStore {
  page: MemoryPage;
  setPage(page: MemoryPage): void;
}

// A local subpage choice, not a persisted record or a new top-level workspace mode.
export const useMemoryNavigationStore = create<MemoryNavigationStore>((set) => ({
  page: 'notes',
  setPage: (page) => set({ page }),
}));
