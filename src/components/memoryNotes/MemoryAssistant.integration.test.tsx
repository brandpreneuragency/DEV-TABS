import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseMemoryNote } from '../../services/memoryNotes/model';
import { db } from '../../services/db';
import { useChatStore } from '../../stores/chatStore';
import { useMemoryNavigationStore } from '../../stores/memoryNavigationStore';
import { useMemoryNotesStore } from '../../stores/memoryNotesStore';
import { MemoryAssistantSidebar, MemoryAssistantSubheader } from './MemoryAssistant';
import { MemoryNotesPage } from './MemoryNotesPage';

const loader = vi.hoisted(() => vi.fn());
vi.mock('../../services/memoryNotes/desktop', () => ({ loadMemoryNotes: loader }));
vi.mock('../sidebar/ChatInput', () => ({ ChatInput: ({ memoryContext }: { memoryContext?: { id: string } }) =>
  <div data-testid="memory-composer" data-context={memoryContext?.id} /> }));
vi.mock('../contextWindow', () => ({ ContextWindowPanel: () => null, ContextWindowSummaryTooltip: () => null,
  ContextWindowRing: () => null }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ i18n: { resolvedLanguage: 'en' },
    t: (key: string, options?: { title?: string }) => options?.title ? `${key}: ${options.title}` : key,
  }),
}));

beforeEach(async () => {
  await db.delete();
  await db.open();
  useChatStore.setState({ threads: [], activeThreadId: null, messagesByThread: {}, currentContext: null,
    contextLoading: false, lastViewedPerContext: {} });
  useMemoryNavigationStore.setState(useMemoryNavigationStore.getInitialState());
  useMemoryNotesStore.setState(useMemoryNotesStore.getInitialState());
  loader.mockReset().mockResolvedValue({ notes: [parseMemoryNote('alpha.md', '# Alpha\nSynthetic alpha'),
    parseMemoryNote('beta.md', '# Beta\nSynthetic beta')], issues: [] });
});

afterEach(cleanup);

it('opens a card-scoped composer and keeps new chats separate when selecting another card', async () => {
  render(<><MemoryNotesPage /><MemoryAssistantSubheader /><MemoryAssistantSidebar /></>);
  const newChat = screen.getByRole('button', { name: 'New chat' });
  expect(newChat).toBeDisabled();
  expect(screen.queryByTestId('memory-composer')).toBeNull();

  fireEvent.click(await screen.findByRole('button', { name: 'memoryNotes.open: Alpha' }));
  const alphaComposer = await screen.findByTestId('memory-composer');
  const alphaId = alphaComposer.getAttribute('data-context');
  expect(alphaId).toBeTruthy();
  expect(newChat).toBeEnabled();
  fireEvent.click(newChat);
  await waitFor(async () => expect(await db.chatThreads.count()).toBe(1));
  const [alphaThread] = await db.chatThreads.toArray();
  expect(alphaThread.memoryId).toBe(alphaId);
  expect(alphaThread.workspaceId).toBeUndefined();

  fireEvent.click(screen.getByRole('button', { name: 'memoryNotes.back' }));
  expect(screen.queryByTestId('memory-composer')).toBeNull();
  expect(newChat).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'memoryNotes.open: Beta' }));
  const betaComposer = await screen.findByTestId('memory-composer');
  expect(betaComposer.getAttribute('data-context')).not.toBe(alphaId);
  expect(useChatStore.getState().activeThreadId).toBeNull();
  expect(useChatStore.getState().threads).toEqual([]);
});
