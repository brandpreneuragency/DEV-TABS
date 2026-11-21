import { useMemorySomedayStore } from '../../stores/memorySomedayStore';
import { MemoryCollectionPage } from '../memoryNotes/MemoryCollectionPage';

export function MemorySomedayPage() {
  return <MemoryCollectionPage store={useMemorySomedayStore} translationKey="memorySomeday" />;
}
