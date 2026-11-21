import { useMemoryToReadStore } from '../../stores/memoryToReadStore';
import { MemoryCollectionPage } from '../memoryNotes/MemoryCollectionPage';

export function MemoryToReadPage() {
  return <MemoryCollectionPage store={useMemoryToReadStore} translationKey="memoryToRead" />;
}
