import { loadMemoryToRead } from '../services/memoryToRead/desktop';
import { createMemoryCollectionStore } from './memoryNotesStore';

// Opening a reading card changes only view selection, never its read/retention status.
export const useMemoryToReadStore = createMemoryCollectionStore(loadMemoryToRead);
