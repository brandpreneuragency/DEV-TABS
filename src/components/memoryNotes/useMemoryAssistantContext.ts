import { useMemoryNavigationStore } from '../../stores/memoryNavigationStore';
import { useMemoryNotesStore } from '../../stores/memoryNotesStore';
import { useMemoryResourcesStore } from '../../stores/memoryResourcesStore';
import { useMemoryToReadStore } from '../../stores/memoryToReadStore';
import { useMemorySomedayStore } from '../../stores/memorySomedayStore';

export function useMemoryAssistantContext() {
  const page = useMemoryNavigationStore((state) => state.page);
  const note = useMemoryNotesStore((state) => page === 'notes'
    ? state.notes.find((item) => item.fileName === state.selectedFileName) : undefined);
  const resource = useMemoryResourcesStore((state) => page === 'resources'
    ? state.notes.find((item) => item.fileName === state.selectedFileName) : undefined);
  const toRead = useMemoryToReadStore((state) => page === 'toRead'
    ? state.notes.find((item) => item.fileName === state.selectedFileName) : undefined);
  const someday = useMemorySomedayStore((state) => page === 'someday'
    ? state.notes.find((item) => item.fileName === state.selectedFileName) : undefined);
  const selected = note ?? resource ?? toRead ?? someday;

  return selected ? { workspaceId: `memory:${page}:${selected.fileName}`, note: selected } : null;
}
