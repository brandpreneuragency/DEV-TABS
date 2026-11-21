import 'fake-indexeddb/auto';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../services/db';
import { useChatStore } from '../stores/chatStore';
import { useStreamingChat } from './useStreamingChat';
import type { MemoryChatContext } from '../services/memoryNotes/chatContext';

const mocks = vi.hoisted(() => ({
  send: vi.fn(), start: vi.fn(), setSession: vi.fn(), setBusy: vi.fn(),
  addProvisionalUser: vi.fn(), snapshot: vi.fn(), createSession: vi.fn(),
}));
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../services/runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('../services/providers/modelVisibility', () => ({
  loadProviderModelVisibility: vi.fn().mockResolvedValue({}), visibleProviderModels: (models: unknown[]) => models,
}));
vi.mock('../services/openCode/promptDispatch', () => ({ dispatchOpenCodePrompt: mocks.send }));
vi.mock('../services/openCode/toolBridge', () => ({ cancelToolContext: vi.fn() }));
vi.mock('../services/openCode/desktopClient', () => ({ openCodeClient: {
  discover: vi.fn().mockResolvedValue({ state: 'connected', workspace: 'C:/synthetic-opencode' }),
  listModels: vi.fn().mockResolvedValue([{ id: 'provider/model', providerId: 'provider', modelId: 'model', enabled: true }]),
  listAgents: vi.fn().mockResolvedValue([]), createSession: mocks.createSession,
} }));
vi.mock('../services/openCode/sessionService', () => ({ openCodeSessionService: { reconcileBindings: vi.fn() } }));
vi.mock('../stores/openCodeStore', () => ({ useOpenCodeStore: {
  getState: () => ({ start: mocks.start, setSession: mocks.setSession, setBusy: mocks.setBusy,
    addProvisionalUser: mocks.addProvisionalUser, snapshot: mocks.snapshot }),
  setState: vi.fn(),
} }));

const memory: MemoryChatContext = { id: '["notes","one.md"]' };

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.send.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue(undefined);
  mocks.snapshot.mockResolvedValue(undefined);
  mocks.createSession.mockImplementation(async ({ threadId }: { threadId: string }) => ({
    id: 'session', threadId, projectId: 'project', directory: 'C:/synthetic-opencode',
  }));
  await db.delete();
  await db.open();
  useChatStore.setState({ threads: [], activeThreadId: null, messagesByThread: {},
    currentContext: null, contextLoading: false, lastViewedPerContext: {} });
  await useChatStore.getState().loadThreadsForContext({ memoryId: memory.id });
});

it('submits through the item-specific OpenCode thread without attaching the item', async () => {
  const hook = renderHook(() => useStreamingChat('', 'writer', undefined, undefined, undefined, null, memory));
  await act(async () => { await hook.result.current.sendMessage('Summarize this'); });

  expect(mocks.send).toHaveBeenCalledOnce();
  const sent = mocks.send.mock.calls[0][0];
  expect(sent.text).toBe('Summarize this');
  expect(sent.context).not.toContain('one.md');
  expect(sent.scope.document).toBeUndefined();
  expect(sent.scope.permissionProfile).toBe('readOnly');
  expect((await db.chatThreads.get(sent.threadId))?.memoryId).toBe(memory.id);
  expect((await db.openCodeChats.get(sent.threadId))?.memoryId).toBe(memory.id);
  hook.unmount();
});

it('refuses to submit a Memory item to a thread owned by another context', async () => {
  await db.chatThreads.add({ id: 'other-thread', mode: 'writer', workspaceId: 'other-workspace',
    origin: 'openCode', title: 'Other', createdAt: 1, updatedAt: 1 });
  useChatStore.setState({ activeThreadId: 'other-thread' });
  const hook = renderHook(() => useStreamingChat('', 'writer', undefined, undefined, undefined, null, memory));
  await expect(hook.result.current.sendMessage('Summarize this')).rejects.toThrow('different context');
  expect(mocks.send).not.toHaveBeenCalled();
  hook.unmount();
});
