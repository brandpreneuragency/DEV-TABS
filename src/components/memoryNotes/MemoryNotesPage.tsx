import { useMemoryNotesStore } from '../../stores/memoryNotesStore';
import { MemoryCollectionPage } from './MemoryCollectionPage';

export function MemoryNotesPage() {
  return <MemoryCollectionPage store={useMemoryNotesStore} translationKey="memoryNotes" />;
}
