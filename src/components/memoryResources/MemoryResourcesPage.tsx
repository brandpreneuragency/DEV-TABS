import { useMemoryResourcesStore } from '../../stores/memoryResourcesStore';
import { MemoryCollectionPage } from '../memoryNotes/MemoryCollectionPage';

export function MemoryResourcesPage() {
  return <MemoryCollectionPage store={useMemoryResourcesStore} translationKey="memoryResources" withCategories />;
}
