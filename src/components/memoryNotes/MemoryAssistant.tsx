import { AISidebar } from '../sidebar/AISidebar';
import { RightPanelSubheader } from '../sidebar/RightPanelSubheader';
import { useMemoryChatContext } from '../../hooks/useMemoryChatContext';

export function MemoryAssistantSidebar() {
  const context = useMemoryChatContext();
  return <AISidebar key={context?.id ?? 'memory-empty'} workspaceId={null} taskId={null}
    mode="writer" editor={null} memoryContext={context} />;
}

export function MemoryAssistantSubheader() {
  const context = useMemoryChatContext();
  return <RightPanelSubheader mode="writer" workspaceId={null} taskId={null} memoryId={context?.id ?? null} />;
}
