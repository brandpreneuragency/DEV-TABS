import { loadMemoryResources } from '../services/memoryResources/desktop';
import { createMemoryCollectionStore } from './memoryNotesStore';

// Separate read lifecycle and selection; never shares records with Notes or Quick Notes.
export const useMemoryResourcesStore = createMemoryCollectionStore(loadMemoryResources);
