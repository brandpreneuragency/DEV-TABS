import { useMemoryNavigationStore } from '../../stores/memoryNavigationStore';
import { MemoryNotesPage } from './MemoryNotesPage';
import { MemoryResourcesPage } from '../memoryResources/MemoryResourcesPage';
import { MemoryToReadPage } from '../memoryToRead/MemoryToReadPage';
import { MemorySomedayPage } from '../memorySomeday/MemorySomedayPage';

export function MemoryWorkspace() {
  const page = useMemoryNavigationStore((state) => state.page);
  if (page === 'someday') return <MemorySomedayPage />;
  if (page === 'toRead') return <MemoryToReadPage />;
  return page === 'resources' ? <MemoryResourcesPage /> : <MemoryNotesPage />;
}
