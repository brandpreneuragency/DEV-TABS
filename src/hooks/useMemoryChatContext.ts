import { useMemo } from 'react';
import { useMemoryNavigationStore } from '../stores/memoryNavigationStore';
import { useMemoryAssistantContext } from '../components/memoryNotes/useMemoryAssistantContext';
import type { MemoryChatContext } from '../services/memoryNotes/chatContext';

/** Selection is independent per collection; only the visible item is a chat target. */
export function useMemoryChatContext(): MemoryChatContext | null {
  const page = useMemoryNavigationStore((state) => state.page);
  const selected = useMemoryAssistantContext()?.note;

  return useMemo(() => selected ? {
    id: JSON.stringify([page, selected.fileName]),
  } : null, [page, selected]);
}
