import { loadMemorySomeday } from '../services/memorySomeday/desktop';
import { createMemoryCollectionStore } from './memoryNotesStore';

// An idea is only displayed; selecting it never creates a task or reminder.
export const useMemorySomedayStore = createMemoryCollectionStore(loadMemorySomeday);
