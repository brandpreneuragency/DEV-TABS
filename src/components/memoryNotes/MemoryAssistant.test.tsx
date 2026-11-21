import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../services/db';
import { parseMemoryNote } from '../../services/memoryNotes/model';
import { useChatStore } from '../../stores/chatStore';
import { useMemoryNavigationStore } from '../../stores/memoryNavigationStore';
import { useMemoryNotesStore } from '../../stores/memoryNotesStore';
import { useMemoryResourcesStore } from '../../stores/memoryResourcesStore';
import { MemoryAssistantSidebar, MemoryAssistantSubheader } from './MemoryAssistant';
import { MemoryNotesNavigation } from './MemoryNotesNavigation';
import { MemoryWorkspace } from './MemoryWorkspace';
import type { MemoryChatContext } from '../../services/memoryNotes/chatContext';

const loaders = vi.hoisted(() => ({ notes: vi.fn(), resources: vi.fn() }));
vi.mock('../../services/memoryNotes/desktop', () => ({ loadMemoryNotes: loaders.notes }));
vi.mock('../../services/memoryResources/desktop', () => ({ loadMemoryResources: loaders.resources }));
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ i18n: { resolvedLanguage: 'en' },
    t: (key: string, options?: { title?: string }) => options?.title ? `${key}: ${options.title}` : key,
  }),
}));
vi.mock('../sidebar/ChatInput', () => ({ ChatInput: ({ memoryContext }: { memoryContext?: MemoryChatContext }) =>
  <div data-testid="memory-composer">{memoryContext?.id}</div> }));
vi.mock('../sidebar/ChatThread', () => ({ ChatThread: () => <div>Chat thread</div> }));
vi.mock('../contextWindow', () => ({ ContextWindowPanel: () => null,
  ContextWindowSummaryTooltip: () => null, ContextWindowRing: () => null }));

const note = parseMemoryNote('shared.md', '# First note\nSynthetic note body');
const resource = { ...parseMemoryNote('shared.md', '# Resource\nSynthetic resource body'), category: null, sourceUrl: null };

beforeEach(async () => {
  await db.delete();
  await db.open();
  useChatStore.setState({ threads: [], activeThreadId: null, messagesByThread: {},
    currentContext: null, contextLoading: false, lastViewedPerContext: {} });
  useMemoryNavigationStore.setState(useMemoryNavigationStore.getInitialState());
  useMemoryNotesStore.setState(useMemoryNotesStore.getInitialState());
  useMemoryResourcesStore.setState(useMemoryResourcesStore.getInitialState());
  loaders.notes.mockReset().mockResolvedValue({ notes: [note], issues: [] });
  loaders.resources.mockReset().mockResolvedValue({ notes: [resource], issues: [] });
});
afterEach(cleanup);

it('enables a separate chat for the opened card and clears it when returning to the grid', async () => {
  render(<><MemoryNotesNavigation /><MemoryWorkspace /><MemoryAssistantSubheader /><MemoryAssistantSidebar /></>);
  expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled();
  expect(screen.queryByTestId('memory-composer')).not.toBeInTheDocument();

  fireEvent.click(await screen.findByRole('button', { name: 'memoryNotes.open: First note' }));
  const noteId = JSON.stringify(['notes', 'shared.md']);
  expect(await screen.findByTestId('memory-composer')).toHaveTextContent(noteId);
  expect(useChatStore.getState().currentContext).toEqual({ memoryId: noteId });
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await waitFor(() => expect(useChatStore.getState().activeThreadId).toBeTruthy());
  const noteThread = useChatStore.getState().activeThreadId;
  expect((await db.chatThreads.get(noteThread!))?.memoryId).toBe(noteId);

  fireEvent.click(screen.getByRole('button', { name: 'memoryResources.resources' }));
  expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled();
  fireEvent.click(await screen.findByRole('button', { name: 'memoryResources.open: Resource' }));
  await waitFor(() => expect(screen.getByTestId('memory-composer')).toHaveTextContent(JSON.stringify(['resources', 'shared.md'])));
  expect(useChatStore.getState().activeThreadId).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await waitFor(() => expect(useChatStore.getState().activeThreadId).toBeTruthy());
  expect(useChatStore.getState().activeThreadId).not.toBe(noteThread);
  expect(useChatStore.getState().currentContext).toEqual({ memoryId: JSON.stringify(['resources', 'shared.md']) });

  fireEvent.click(screen.getByRole('button', { name: 'memoryResources.back' }));
  expect(screen.queryByTestId('memory-composer')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'memoryNotes.notes' }));
  fireEvent.click(await screen.findByRole('button', { name: 'memoryNotes.open: First note' }));
  await waitFor(() => expect(useChatStore.getState().activeThreadId).toBe(noteThread));
});
